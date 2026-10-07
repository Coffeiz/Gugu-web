"""本地文件事实源的统一 TS watcher supervisor。

TS sidecar 负责操作系统文件事件并携带精确路径；本模块优先按路径单点投影。
sidecar 报告不可恢复信号（needs_reconcile/error/缺路径事件）时持久标记缺口；
单点投影失败最多重试三次，耗尽后提示手动核对，不自动启动依赖扫描基线的整树任务。
监听只挂最近活跃用户的绑定，Shell 不参与文件刷新。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select

logger = logging.getLogger(__name__)

from app.core.config import get_settings
from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.db import session as db_session
from app.models import FileSyncBinding, User, Workspace
from app.services.filesync.bindings import resolve_local_binding_root
from app.services.filesync.outbox import deliver_file_event, enqueue_file_event
from app.services.filesync.protocol import (
    FileSyncMode,
    FileSyncSource,
    create_binding,
    is_file_sync_enabled,
)
from app.services.filesync.file_ops import root_fingerprint as _root_fingerprint
from app.services.filesync.targeted import PathEventBatch, project_path_events
from app.services.filesync.activity import set_activity_reliability
from app.services.filesync.health import update_binding_health
from app.services.filesync.ts_sidecar import FileSyncSidecar, FileSyncSidecarUnavailable
from app.services.workspaces import resolve_workspace_root, workspace_shell_supported

_WATCHER_ERROR_CODES = frozenset({
    "watcher_error", "watcher_limit_exceeded", "output_overflow",
    "python_event_queue_overflow", "incomplete_event", "requested",
    "targeted_projection_failed",
})
MAX_TARGETED_PATH_RETRIES = 3


async def _consume_health_event(db, event, pending, compensable_ids) -> bool:
    """持久化 sidecar 健康事件；ready 不会清除待手动核对标记。"""
    kind = event.get("event")
    binding_id = event.get("binding_id")
    if kind == "ready" and isinstance(binding_id, int):
        if db is not None:
            await update_binding_health(db, binding_id, status="ready")
        return True
    if kind not in {"needs_reconcile", "error"}:
        return False

    # 无 id 的全局信号按可补偿全集处理，避免遗漏未监听的绑定。
    target_ids = (binding_id,) if isinstance(binding_id, int) else compensable_ids
    pending.update(target_ids)
    if db is None:
        return True
    code = event.get("code")
    safe_code = code if isinstance(code, str) and code in _WATCHER_ERROR_CODES else "watcher_error"
    for target_id in target_ids:
        await update_binding_health(
            db, target_id, status="degraded", error_code=safe_code, gap_detected=True,
        )
    return True


def _has_changes(summary) -> bool:
    return bool(
        summary.created or summary.updated or summary.moved or summary.deleted
        or summary.folders_created or summary.folders_updated or summary.folders_deleted
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
    """worker 内唯一的本地目录 TS watcher supervisor。"""

    def __init__(
        self,
        *,
        refresh_interval: float = 10.0,
        sidecar: FileSyncSidecar | None = None,
    ):
        self.refresh_interval = refresh_interval
        self._sidecar = sidecar or FileSyncSidecar()
        self._binding_roots: dict[int, Path] = {}
        self._last_refresh = 0.0
        self._path_events: dict[int, PathEventBatch] = {}
        self._path_event_retries: dict[int, int] = {}
        self._sidecar_failure_active = False

    async def _active_user_ids(self, db, bindings: list[FileSyncBinding]) -> set:
        """活跃度门控：只给最近活跃用户挂监听；0 天窗口表示全部监听。"""
        window_days = int(get_settings().filesync.active_window_days)
        user_ids = {binding.user_id for binding in bindings}
        if window_days <= 0 or not user_ids:
            return user_ids
        threshold = now_utc() - timedelta(days=window_days)
        rows = await db.scalars(select(User.id).where(
            User.id.in_(user_ids), User.is_active.is_(True), User.last_active_at >= threshold,
        ))
        return set(rows.all())

    async def _sync_sidecar_watches(self, db, current, watched, pending) -> None:
        """注册或注销监听；注册时先持久标记可能存在的停机缺口。"""
        for binding_id in sorted(watched):
            _binding, root = current[binding_id]
            if self._binding_roots.get(binding_id) == root:
                continue
            await self._sidecar.watch(binding_id, root)
            self._binding_roots[binding_id] = root
            await update_binding_health(
                db, binding_id, status="starting", gap_detected=True,
            )
            pending.add(binding_id)

        for binding_id in set(self._binding_roots) - watched:
            await self._sidecar.unwatch(binding_id)
            self._binding_roots.pop(binding_id, None)
            self._path_event_retries.pop(binding_id, None)

    async def _update_user_activity_reliability(
        self, db, bindings, watched, pending,
    ) -> None:
        by_user: dict[object, list[FileSyncBinding]] = {}
        for binding in bindings:
            if binding.mode != FileSyncMode.MIRROR_OUT:
                by_user.setdefault(binding.user_id, []).append(binding)
                if binding.needs_reconcile:
                    pending.add(binding.id)
                elif binding.id in watched and binding.watcher_status == "ready":
                    pending.discard(binding.id)
        for user_id, user_bindings in by_user.items():
            await set_activity_reliability(
                db, user_id,
                all(
                    binding.id in watched
                    and binding.id not in pending
                    and binding.id not in self._path_events
                    and not binding.needs_reconcile
                    for binding in user_bindings
                ),
            )

    async def _handle_path_projection_failure(
        self, db, binding_id: int, batch: PathEventBatch, exc: Exception,
        pending: set[int],
    ) -> None:
        """有限重试精确路径；重试耗尽后持久记录人工核对缺口。"""
        await db.rollback()
        diag_log("filesync.watcher.project_path_events", exc)
        retries = self._path_event_retries.get(binding_id, 0)
        if retries < MAX_TARGETED_PATH_RETRIES:
            self._path_event_retries[binding_id] = retries + 1
            self._path_events.setdefault(binding_id, PathEventBatch()).merge(batch)
            pending.add(binding_id)
            logger.warning(
                "[worker] 文件单点投影失败，将按精确路径重试 binding=%s attempt=%s",
                binding_id, retries + 1,
            )
            return

        try:
            await update_binding_health(
                db, binding_id, status="degraded",
                error_code="targeted_projection_failed", gap_detected=True,
            )
        except Exception as health_exc:
            await db.rollback()
            self._path_events.setdefault(binding_id, PathEventBatch()).merge(batch)
            self._path_event_retries[binding_id] = retries
            diag_log("filesync.watcher.mark_targeted_gap", health_exc)
            logger.warning(
                "[worker] 文件单点投影缺口暂时无法持久化，保留精确路径 binding=%s",
                binding_id,
            )
            return

        self._path_event_retries.pop(binding_id, None)
        pending.add(binding_id)
        logger.warning(
            "[worker] 文件单点投影重试耗尽，需手动核对 binding=%s error_type=%s",
            binding_id, type(exc).__name__,
        )

    async def _flush_summary_event(self, db, binding: FileSyncBinding, summary) -> None:
        if not _has_changes(summary):
            return
        event = await enqueue_file_event(
            db, binding.user_id, operation="refresh",
            entity_ids=summary.entity_ids,
            source=FileSyncSource.LOCAL_DIRECTORY,
            revision=binding.revision,
        )
        await db.commit()
        await deliver_file_event(db, event)
        await db.commit()

    async def _refresh_sidecar_bindings(
        self, db, bindings: list[FileSyncBinding], pending: set[int],
    ) -> tuple[dict[int, tuple[FileSyncBinding, Path]], set[int]]:
        """返回当前可用绑定全集与实际挂监听的活跃子集。"""
        active_users = await self._active_user_ids(db, bindings)
        current: dict[int, tuple[FileSyncBinding, Path]] = {}
        for binding in bindings:
            root = await _binding_root(db, binding)
            if root is None or not root.exists() or not root.is_dir():
                continue
            current[binding.id] = (binding, root)
        watched = {
            binding_id for binding_id, (binding, _) in current.items()
            if binding.user_id in active_users and binding.mode != FileSyncMode.MIRROR_OUT
        }
        await self._sync_sidecar_watches(db, current, watched, pending)
        await self._update_user_activity_reliability(
            db, bindings, watched, pending,
        )
        return current, watched

    async def _drain_events(
        self, pending: set[int], compensable_ids: set[int], db=None,
    ) -> None:
        while True:
            event = await self._sidecar.next_event()
            if event is None:
                return
            if await _consume_health_event(db, event, pending, compensable_ids):
                continue
            kind = event.get("event")
            binding_id = event.get("binding_id")
            if kind == "change" and isinstance(binding_id, int):
                relative = event.get("relative_path")
                operation = event.get("operation")
                object_type = event.get("object_type")
                if (
                    isinstance(relative, str) and relative
                    and operation in {"create", "update", "delete"}
                    and object_type in {"file", "folder"}
                ):
                    batch = self._path_events.setdefault(binding_id, PathEventBatch())
                    if object_type == "file":
                        if operation == "delete":
                            batch.deleted.add(relative)
                            batch.changed.discard(relative)
                        else:
                            batch.changed.add(relative)
                            batch.deleted.discard(relative)
                    else:
                        if operation == "delete":
                            batch.folders_deleted.add(relative)
                            batch.folders_created.discard(relative)
                        else:
                            batch.folders_created.add(relative)
                            batch.folders_deleted.discard(relative)
                else:
                    # 缺路径/未知形态无法安全投影；显式留缺口供人工核对。
                    pending.add(binding_id)
                    if db is not None:
                        await update_binding_health(
                            db, binding_id, status="degraded",
                            error_code="incomplete_event", gap_detected=True,
                        )

    async def _project_path_events(
        self, db, current, pending: set[int] | None = None,
    ) -> None:
        """消费精确事件；失败后有限重试，耗尽则提示手动核对。"""
        pending = pending if pending is not None else set()
        for binding_id in list(self._path_events):
            batch = self._path_events.pop(binding_id)
            entry = current.get(binding_id)
            if entry is None or batch.empty():
                continue
            binding, root = entry
            try:
                # 前一次路径事务 rollback 会让 Session 中的所有 ORM 对象过期。
                await db.refresh(binding)
                summary = await project_path_events(db, binding.user_id, binding, root, batch)
                await db.commit()
                await self._flush_summary_event(db, binding, summary)
                self._path_event_retries.pop(binding_id, None)
                if not binding.needs_reconcile and binding.watcher_status == "ready":
                    pending.discard(binding_id)
            except Exception as exc:
                await self._handle_path_projection_failure(
                    db, binding_id, batch, exc, pending,
                )

    async def run(self, stop_event: asyncio.Event) -> None:
        """持续消费 TS 文件事件；worker 停止时关闭 sidecar。"""
        loop = asyncio.get_running_loop()
        pending: set[int] = set()
        try:
            while not stop_event.is_set():
                if not is_file_sync_enabled() or not workspace_shell_supported():
                    await self._sidecar.close()
                    self._binding_roots.clear()
                    pending.clear()
                    self._path_events.clear()
                    self._path_event_retries.clear()
                    await asyncio.sleep(min(self.refresh_interval, 5.0))
                    continue
                now = loop.time()
                try:
                    await self._sidecar.start()
                    async with db_session._SessionLocal() as db:
                        if now - self._last_refresh >= self.refresh_interval:
                            bindings = await _refresh_bindings(db)
                            self._last_refresh = now
                            await db.commit()
                        else:
                            bindings = list((await db.scalars(select(FileSyncBinding).where(
                                FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
                                FileSyncBinding.status == "active",
                            ))).all())
                        current, watched = await self._refresh_sidecar_bindings(db, bindings, pending)
                        # 无绑定 id 的 sidecar 缺口按所有有效绑定标记，不升级为整树任务。
                        binding_ids = set(current)
                        await self._drain_events(pending, binding_ids, db)
                        await self._project_path_events(db, current, pending)
                        await db.commit()
                    self._sidecar_failure_active = False
                except FileSyncSidecarUnavailable:
                    async with db_session._SessionLocal() as db:
                        bindings = (await db.scalars(select(FileSyncBinding).where(
                            FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
                            FileSyncBinding.status == "active",
                        ))).all()
                        for binding in bindings:
                            pending.add(binding.id)
                            await set_activity_reliability(db, binding.user_id, False)
                            if not self._sidecar_failure_active:
                                await update_binding_health(
                                    db, binding.id, status="degraded",
                                    error_code="watcher_error", gap_detected=True,
                                )
                        await db.commit()
                    self._sidecar_failure_active = True
                    await self._sidecar.close()
                    # sidecar 进程内的 watch 状态随进程一起丢失；清空本地缓存，
                    # 下一轮启动后重新注册全部 watch，历史缺口由健康状态提示人工核对。
                    self._binding_roots.clear()
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    diag_log("filesync.watcher.loop", exc)
                    logger.warning(
                        "[worker] 文件同步 watcher 出错 error_type=%s",
                        type(exc).__name__,
                    )
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self._sidecar.close()
