"""本地文件事实源的 TS watcher supervisor；缺口修复交给持久化任务队列。"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select

logger = logging.getLogger(__name__)

from app.core.config import get_settings
from app.core.tz import now_utc
from app.db import session as db_session
from app.models import FileSyncBinding, User, Workspace
from app.services.filesync.bindings import resolve_local_binding_root
from app.services.filesync.jobs import ReconcileRunError, enqueue_reconcile_run
from app.services.filesync.outbox import deliver_file_event, enqueue_file_event
from app.services.filesync.health import update_binding_health
from app.services.filesync.inotify_limit_client import InotifyLimitUnavailable, request_limit_agent
from app.services.filesync.protocol import FileSyncSource, create_binding, is_file_sync_enabled
from app.services.filesync.reconcile import _root_fingerprint
from app.services.filesync.targeted import PathEventBatch, PathProjectionOptions, project_path_events
from agent.sandbox.client import SandboxdClient, SandboxdUnavailable
from app.services.filesync.ts_sidecar import FileSyncSidecar, FileSyncSidecarUnavailable
from app.services.workspaces import resolve_workspace_root, workspace_shell_supported


def _has_changes(summary) -> bool:
    return bool(
        summary.created or summary.updated or summary.moved or summary.deleted
        or summary.folders_created or summary.folders_updated or summary.folders_deleted
    )


def _projection_rejection_code(summary) -> str:
    """只将固定原因码和聚合计数写入绑定健康状态，不保存路径或文件名。"""
    labels = {
        "invalid_or_unsupported_path": "invalid",
        "file_unavailable": "file_missing",
        "file_filesystem_error": "file_io",
        "folder_unavailable": "folder_missing",
        "folder_filesystem_error": "folder_io",
        "quota_exceeded": "quota",
        "projection_root_unavailable": "root",
        "snapshot_unavailable": "snapshot",
    }
    totals: dict[str, int] = {}
    for reason, count in summary.rejection_reasons:
        if count:
            label = labels.get(reason, "other")
            totals[label] = totals.get(label, 0) + int(count)
    reasons = sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    if not reasons:
        return "path_projection_rejected"

    prefix = "path_projection_rejected:"
    details: list[str] = []
    for label, count in reasons:
        item = f"{label}={count}"
        candidate = f"{prefix}{','.join((*details, item))}"
        if len(candidate) > 64:
            remainder = len(reasons) - len(details)
            item = f"other={remainder}"
            candidate = f"{prefix}{','.join((*details, item))}"
            if len(candidate) > 64:
                return "path_projection_rejected:multiple"
            return candidate
        details.append(item)
    return f"{prefix}{','.join(details)}"


_RETRYABLE_PROJECTION_REJECTIONS = {
    "file_unavailable",
    "file_filesystem_error",
    "folder_unavailable",
    "folder_filesystem_error",
    "projection_root_unavailable",
    "snapshot_unavailable",
}


def _has_retryable_projection_rejection(summary) -> bool:
    return any(
        reason in _RETRYABLE_PROJECTION_REJECTIONS and count > 0
        for reason, count in summary.rejection_reasons
    )


async def _refresh_bindings(db) -> list[FileSyncBinding]:
    """补偿登记所有启用的本地 workspace，并返回可监听绑定。"""
    workspaces = (await db.scalars(select(Workspace).where(Workspace.enabled.is_(True)))).all()
    for workspace in workspaces:
        if not workspace_shell_supported():
            break
        root = await resolve_workspace_root(db, workspace.user_id, workspace.id)
        if root is None:
            continue
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.user_id == workspace.user_id,
            FileSyncBinding.workspace_id == workspace.id,
            FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
        ))
        if binding is None:
            await create_binding(
                db, user_id=workspace.user_id, workspace_id=workspace.id,
                source=FileSyncSource.LOCAL_DIRECTORY,
                root_fingerprint=_root_fingerprint(root), root_path=".",
            )
    await db.flush()
    return list((await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
        FileSyncBinding.status == "active",
    ))).all())


async def _binding_root(db, binding: FileSyncBinding) -> Path | None:
    if binding.workspace_id is not None:
        return await resolve_workspace_root(db, binding.user_id, binding.workspace_id)
    try:
        _, root = resolve_local_binding_root(binding.user_id, binding.root_path)
    except (OSError, ValueError):
        return None
    return root


class FileSyncWatcherManager:
    """worker 内唯一的 watcher supervisor，注册与事件消费并行运行。"""

    MAX_EVENTS_PER_TICK = 1000
    MAX_BUFFERED_PATHS = 20_000
    MAX_PATH_RETRIES = 3

    def __init__(self, *, refresh_interval: float = 10.0, sidecar: FileSyncSidecar | None = None):
        self.refresh_interval = refresh_interval
        self._sidecar = sidecar or FileSyncSidecar()
        self._binding_roots: dict[int, tuple[object, Path, str]] = {}
        self._binding_scopes: dict[int, tuple[str, ...] | None] = {}
        self._path_events: dict[int, PathEventBatch] = {}
        self._retry_count: dict[int, int] = {}
        self._ready_bindings: set[int] = set()
        self._rebuild_bindings: set[int] = set()
        self._rebuild_attempts: dict[int, int] = {}
        self._unavailable_bindings: set[int] = set()
        self._inactive_bindings: set[int] = set()
        self._watcher_limit_seen: int | None = None
        self._refresh_lock = asyncio.Lock()
        self._buffered_path_count = 0
        self._buffered_path_keys: set[tuple[int, str]] = set()

    async def _health(self, binding_id: int, status: str, *, code: str | None = None, gap: bool = False) -> None:
        async with db_session._SessionLocal() as db:
            await update_binding_health(
                db, binding_id, status=status, error_code=code, gap_detected=gap,
            )

    async def _enqueue_gap_repair(self, binding_id: int) -> None:
        """把监听缺口转成持久化的、禁止自动删除的修复任务。"""
        async with db_session._SessionLocal() as db:
            binding = await db.scalar(select(FileSyncBinding).where(
                FileSyncBinding.id == binding_id,
                FileSyncBinding.status == "active",
                FileSyncBinding.mode != "mirror_out",
            ))
            if binding is None:
                return
            try:
                await enqueue_reconcile_run(
                    db,
                    user_id=binding.user_id,
                    binding_id=binding.id,
                    action="repair",
                    allow_delete=False,
                )
            except (LookupError, ReconcileRunError):
                await db.rollback()
                return
            await db.commit()

    async def _prepare_filesync_access(self, root: Path) -> None:
        """按需给 watcher 进程修复沙盒私有目录的 ACL。"""
        sandbox_settings = get_settings().sandbox
        socket_path = sandbox_settings.sandboxd_socket
        await SandboxdClient(socket_path, connect_timeout=3).prepare_filesync_access(root)

    async def _expand_watcher_capacity_if_needed(self) -> None:
        """占用到 80% 时自动扩容；检测手工/自动扩容后恢复失败的 binding。"""
        try:
            result = await request_limit_agent(
                "auto_expand", get_settings().filesync.watch_hard_limit,
            )
        except InotifyLimitUnavailable:
            return
        current_limit = result.get("limit")
        grew = isinstance(current_limit, int) and self._watcher_limit_seen is not None \
            and current_limit > self._watcher_limit_seen
        self._watcher_limit_seen = current_limit if isinstance(current_limit, int) else self._watcher_limit_seen
        if not result.get("expanded") and not grew:
            return
        # ENOSPC binding 已进入 rebuild；清除短重试熔断，让它在新额度下重新注册。
        for binding_id in tuple(self._binding_roots):
            if binding_id in self._rebuild_bindings:
                self._rebuild_attempts.pop(binding_id, None)

    def _discard_buffered_batch(self, binding_id: int) -> None:
        batch = self._path_events.pop(binding_id, None)
        if batch is not None:
            for path in batch.all_paths():
                self._buffered_path_keys.discard((binding_id, path))
                self._buffered_path_count -= 1

    def _restore_batch(self, binding_id: int, older: PathEventBatch) -> None:
        """把投影期间新到事件合并到失败批次，新事件对同一路径优先。"""
        newer = self._path_events.pop(binding_id, None)
        if newer is None:
            self._path_events[binding_id] = older
            for path in older.all_paths():
                key = (binding_id, path)
                if key not in self._buffered_path_keys:
                    self._buffered_path_keys.add(key)
                    self._buffered_path_count += 1
            return
        for path in newer.changed:
            older.deleted.discard(path)
            older.changed.add(path)
        older.created_files.update(newer.created_files)
        for path in newer.deleted:
            older.changed.discard(path)
            older.deleted.add(path)
            older.created_files.discard(path)
        for path in newer.folders_created:
            older.folders_deleted.discard(path)
            older.folders_created.add(path)
        for path in newer.folders_deleted:
            older.folders_created.discard(path)
            older.folders_deleted.add(path)
        self._path_events[binding_id] = older
        for path in older.all_paths():
            key = (binding_id, path)
            if key not in self._buffered_path_keys:
                self._buffered_path_keys.add(key)
                self._buffered_path_count += 1

    async def _active_user_ids(self, db, bindings: list[FileSyncBinding]) -> set:
        window_days = int(get_settings().filesync.active_window_days)
        user_ids = {binding.user_id for binding in bindings}
        if window_days <= 0 or not user_ids:
            return user_ids
        rows = await db.scalars(select(User.id).where(
            User.id.in_(user_ids), User.is_active.is_(True),
            User.last_active_at >= now_utc() - timedelta(days=window_days),
        ))
        return set(rows.all())

    async def _refresh_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            if not is_file_sync_enabled() or not workspace_shell_supported():
                await self._sidecar.close()
                self._binding_roots.clear()
                self._binding_scopes.clear()
                self._ready_bindings.clear()
                await self._wait(stop_event)
                continue
            try:
                await self._sidecar.start()
                await self._expand_watcher_capacity_if_needed()
                async with db_session._SessionLocal() as db:
                    bindings = await _refresh_bindings(db)
                    active_users = await self._active_user_ids(db, bindings)
                    current: dict[int, tuple[object, Path, str]] = {}
                    current_scopes: dict[int, tuple[str, ...] | None] = {}
                    unavailable: list[int] = []
                    inactive_ids = {
                        binding.id for binding in bindings if binding.user_id not in active_users
                    }
                    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
                    for binding in bindings:
                        if binding.user_id not in active_users:
                            continue
                        root = await _binding_root(db, binding)
                        if root is None or not root.is_dir():
                            unavailable.append(binding.id)
                            continue
                        current[binding.id] = (binding.user_id, root, binding.mode)
                        user_root = (storage_root / str(binding.user_id)).resolve()
                        current_scopes[binding.id] = (
                            ("个人文件", "项目文件")
                            if binding.workspace_id is None and root.resolve() == user_root
                            else None
                        )
                    await db.commit()

                async with self._refresh_lock:
                    for binding_id in set(self._binding_roots) - set(current):
                        await self._sidecar.unwatch(binding_id)
                        self._binding_roots.pop(binding_id, None)
                        self._binding_scopes.pop(binding_id, None)
                        self._ready_bindings.discard(binding_id)
                        self._discard_buffered_batch(binding_id)
                    for binding_id in unavailable:
                        if binding_id not in self._unavailable_bindings:
                            await self._health(binding_id, "unavailable", code="binding_root_unavailable", gap=True)
                            self._unavailable_bindings.add(binding_id)
                    watch_ids = {
                        binding_id for binding_id, (user_id, _, _) in current.items()
                        if user_id in active_users
                    }
                    for binding_id in set(self._binding_roots) - watch_ids:
                        await self._sidecar.unwatch(binding_id)
                        self._binding_roots.pop(binding_id, None)
                        self._binding_scopes.pop(binding_id, None)
                        self._ready_bindings.discard(binding_id)
                        self._discard_buffered_batch(binding_id)
                    for binding_id in inactive_ids:
                        if binding_id not in self._inactive_bindings:
                            # 非活跃用户不监听；恢复活跃时的 watcher 启动会标记离线期间缺口。
                            # 不要在每次 worker 重启时把未监听状态本身误报为同步缺口。
                            await self._health(binding_id, "inactive")
                            self._inactive_bindings.add(binding_id)
                    for binding_id in sorted(watch_ids):
                        user_id, root, mode = current[binding_id]
                        self._unavailable_bindings.discard(binding_id)
                        resumed_after_inactive = binding_id in self._inactive_bindings
                        self._inactive_bindings.discard(binding_id)
                        previous = self._binding_roots.get(binding_id)
                        previous_scope = self._binding_scopes.get(binding_id)
                        scope = current_scopes[binding_id]
                        self._binding_roots[binding_id] = (user_id, root, mode)
                        self._binding_scopes[binding_id] = scope
                        rebuilding = binding_id in self._rebuild_bindings
                        if rebuilding and self._rebuild_attempts.get(binding_id, 0) >= self.MAX_PATH_RETRIES:
                            continue
                        if previous != (user_id, root, mode) or previous_scope != scope or rebuilding:
                            self._ready_bindings.discard(binding_id)
                            if rebuilding:
                                await self._sidecar.unwatch(binding_id)
                                self._rebuild_attempts[binding_id] = self._rebuild_attempts.get(binding_id, 0) + 1
                                await self._health(binding_id, "starting")
                            else:
                                # 普通 worker 启动/重启本身不是 watcher 故障；停机期间的
                                # 手工文件变化由周期完整扫描发现，不把所有绑定立即标红。
                                await self._health(
                                    binding_id,
                                    "starting",
                                    gap=previous is not None or resumed_after_inactive,
                                )
                            await self._sidecar.watch(binding_id, root, included_root_entries=scope)
            except asyncio.CancelledError:
                raise
            except FileSyncSidecarUnavailable:
                for binding_id in tuple(self._binding_roots):
                    await self._health(binding_id, "failed", code="sidecar_unavailable", gap=True)
                await self._sidecar.close()
                self._binding_roots.clear()
                self._binding_scopes.clear()
                self._ready_bindings.clear()
            except Exception as exc:
                logger.warning("[worker] 文件监听注册刷新失败 error=%s", type(exc).__name__)
            await self._wait(stop_event)

    async def _wait(self, stop_event: asyncio.Event) -> None:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=self.refresh_interval)
        except asyncio.TimeoutError:
            pass

    def _queue_path_event(self, event: dict) -> bool:
        binding_id = event.get("binding_id")
        relative = event.get("relative_path")
        operation = event.get("operation")
        object_type = event.get("object_type")
        if binding_id not in self._binding_roots:
            return False
        if not (isinstance(relative, str) and relative and operation in {"create", "update", "delete"}
                and object_type in {"file", "folder"}):
            return False
        batch = self._path_events.setdefault(binding_id, PathEventBatch())
        target = (batch.changed if object_type == "file" and operation != "delete" else
                  batch.deleted if object_type == "file" else
                  batch.folders_created if operation != "delete" else batch.folders_deleted)
        opposite = (batch.deleted if target is batch.changed else
                    batch.changed if target is batch.deleted else
                    batch.folders_deleted if target is batch.folders_created else batch.folders_created)
        path_key = (binding_id, relative)
        new_path = path_key not in self._buffered_path_keys
        if new_path and self._buffered_path_count >= self.MAX_BUFFERED_PATHS:
            return False
        if new_path:
            self._buffered_path_keys.add(path_key)
            self._buffered_path_count += 1
        target.add(relative)
        opposite.discard(relative)
        if object_type == "file":
            if operation == "create":
                batch.created_files.add(relative)
            elif operation == "delete":
                batch.created_files.discard(relative)
        return True

    async def _handle_event(self, event: dict) -> None:
        kind = event.get("event")
        binding_id = event.get("binding_id")
        if kind == "ready" and isinstance(binding_id, int):
            if binding_id in self._binding_roots:
                self._ready_bindings.add(binding_id)
                self._rebuild_bindings.discard(binding_id)
                self._rebuild_attempts.pop(binding_id, None)
                await self._health(binding_id, "ready")
            return
        if kind in {"needs_reconcile", "error"}:
            code = event.get("code") if isinstance(event.get("code"), str) else "watcher_gap"
            targets = [binding_id] if isinstance(binding_id, int) else list(self._binding_roots)
            for target in targets:
                if target in self._binding_roots:
                    if (
                        kind == "needs_reconcile" and code == "watcher_permission_denied"
                        and get_settings().sandbox.manager_mode in {"embedded", "external"}
                        and self._rebuild_attempts.get(target, 0) < self.MAX_PATH_RETRIES
                    ):
                        binding_spec = self._binding_roots[target]
                        await self._sidecar.unwatch(target)
                        self._ready_bindings.discard(target)
                        self._rebuild_bindings.add(target)
                        try:
                            await self._prepare_filesync_access(binding_spec[1])
                        except SandboxdUnavailable:
                            await self._health(
                                target, "degraded", code="workspace_permission_repair_failed", gap=True,
                            )
                            await self._enqueue_gap_repair(target)
                            continue
                    await self._health(target, "degraded", code=code, gap=True)
                    if kind == "needs_reconcile":
                        await self._enqueue_gap_repair(target)
                    if kind == "error" and isinstance(target, int):
                        self._rebuild_bindings.add(target)
            return
        if kind == "change":
            if isinstance(binding_id, int) and binding_id in self._binding_roots:
                if not self._queue_path_event(event):
                    await self._health(binding_id, "degraded", code="event_buffer_overflow", gap=True)
                    await self._enqueue_gap_repair(binding_id)

    async def _project_pending(self) -> None:
        for binding_id in tuple(self._path_events):
            binding_spec = self._binding_roots.get(binding_id)
            if binding_spec is None:
                continue
            batch = self._path_events.pop(binding_id)
            for path in batch.all_paths():
                self._buffered_path_keys.discard((binding_id, path))
                self._buffered_path_count -= 1
            user_id, root, mode = binding_spec
            if mode == "mirror_out" or batch.empty():
                continue
            try:
                async with db_session._SessionLocal() as db:
                    binding = await db.scalar(select(FileSyncBinding).where(
                        FileSyncBinding.id == binding_id,
                        FileSyncBinding.user_id == user_id,
                        FileSyncBinding.status == "active",
                    ))
                    if binding is None:
                        continue
                    summary = await project_path_events(
                        db, user_id, binding, root, batch,
                        options=PathProjectionOptions(record_quota_deltas=True),
                    )
                    event_row = None
                    if _has_changes(summary):
                        event_row = await enqueue_file_event(
                            db, user_id, operation="refresh", entity_ids=summary.entity_ids,
                            source=FileSyncSource.LOCAL_DIRECTORY, revision=binding.revision,
                        )
                    await db.commit()
                    if event_row is not None:
                        await deliver_file_event(db, event_row)
                        await db.commit()
                self._retry_count.pop(binding_id, None)
                if summary.rejected:
                    await self._health(
                        binding_id, "degraded",
                        code=_projection_rejection_code(summary), gap=True,
                    )
                    if _has_retryable_projection_rejection(summary):
                        await self._enqueue_gap_repair(binding_id)
            except asyncio.CancelledError:
                self._restore_batch(binding_id, batch)
                raise
            except Exception as exc:
                retry = self._retry_count.get(binding_id, 0) + 1
                self._retry_count[binding_id] = retry
                if retry < self.MAX_PATH_RETRIES:
                    self._restore_batch(binding_id, batch)
                else:
                    self._retry_count.pop(binding_id, None)
                    await self._health(binding_id, "degraded", code="path_projection_failed", gap=True)
                    await self._enqueue_gap_repair(binding_id)
                logger.warning("[worker] 文件单路径投影失败 binding=%s error=%s", binding_id, type(exc).__name__)

    async def _consume_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                for _ in range(self.MAX_EVENTS_PER_TICK):
                    event = await self._sidecar.next_event()
                    if event is None:
                        break
                    await self._handle_event(event)
                await self._project_pending()
            except asyncio.CancelledError:
                raise
            except FileSyncSidecarUnavailable:
                await asyncio.sleep(0.1)
            except Exception as exc:
                logger.warning("[worker] 文件监听事件消费失败 error=%s", type(exc).__name__)
            await asyncio.sleep(0.05)

    async def run(self, stop_event: asyncio.Event) -> None:
        """注册刷新和事件消费并行运行；任何故障只置健康缺口，不自动整树扫描。"""
        try:
            await asyncio.gather(self._refresh_loop(stop_event), self._consume_loop(stop_event))
        finally:
            await self._sidecar.close()
