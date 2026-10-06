"""本地文件事实源的统一 TS watcher supervisor。

TS sidecar 负责操作系统文件事件并携带精确路径；本模块优先按路径单点投影，
只有 sidecar 报告不可恢复信号（needs_reconcile/error/缺路径事件）或单点投影
失败时才回退整树 reconcile。每日快照差异只对周期内无文件树变化、且活动统计
可靠的用户执行；活动状态不可信时不得跳过补偿。完整内容校验仅用于首次基线、
快照失效与明确的手动请求。监听只挂最近活跃用户的绑定，Shell 不参与文件刷新。
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
from app.models import FileSyncBinding, FileSyncReconcileRun, User, Workspace
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
from app.services.filesync.jobs import enqueue_reconcile
from app.services.filesync.activity import set_activity_reliability
from app.services.filesync.ts_sidecar import FileSyncSidecar, FileSyncSidecarUnavailable
from app.services.workspaces import resolve_workspace_root, workspace_shell_supported


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
        self._pending_fallback: set[int] = set()

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
        """返回 (可补偿绑定全集, 实际挂监听的活跃子集)。"""
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
        for binding_id in sorted(watched):
            binding, root = current[binding_id]
            if self._binding_roots.get(binding_id) != root:
                await self._sidecar.watch(binding_id, root)
                self._binding_roots[binding_id] = root
                pending.add(binding_id)
        for binding_id in set(self._binding_roots) - watched:
            await self._sidecar.unwatch(binding_id)
            self._binding_roots.pop(binding_id, None)
            pending.discard(binding_id)
            self._path_events.pop(binding_id, None)
        by_user: dict[object, list[int]] = {}
        for binding in bindings:
            if binding.mode != FileSyncMode.MIRROR_OUT:
                by_user.setdefault(binding.user_id, []).append(binding.id)
        active_run_users = set((await db.scalars(select(FileSyncReconcileRun.user_id).where(
            FileSyncReconcileRun.status.in_(("queued", "running", "paused", "cancelling")),
            # 普通每日任务本身不代表 watcher 不可靠。否则任务刚入队时
            # reliability 会被清零，claim 阶段就无法按最新活动水位跳过它。
            FileSyncReconcileRun.reason == "event_fallback",
        ))).all())
        for user_id, user_binding_ids in by_user.items():
            await set_activity_reliability(
                db, user_id,
                user_id not in active_run_users
                and all(
                    binding_id in watched
                    and binding_id not in pending
                    and binding_id not in self._pending_fallback
                    and binding_id not in self._path_events
                    for binding_id in user_binding_ids
                ),
            )
        return current, watched

    async def _drain_events(self, pending: set[int], compensable_ids: set[int]) -> None:
        while True:
            event = await self._sidecar.next_event()
            if event is None:
                return
            kind = event.get("event")
            binding_id = event.get("binding_id")
            if kind in {"needs_reconcile", "error"}:
                if isinstance(binding_id, int):
                    pending.add(binding_id)
                else:
                    # 无 id 的全局信号：sidecar 只监听活跃绑定，但按可补偿全集
                    # 自愈不会漏掉任何绑定，代价只是多几次低频对账。
                    pending.update(compensable_ids)
                continue
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
                    # 缺路径/未知形态的事件无法单点裁决，退回整树对账。
                    pending.add(binding_id)

    async def _project_path_events(self, db, current) -> None:
        """消费缓冲的精确事件；意外异常时回退该绑定的整树补偿。"""
        for binding_id in list(self._path_events):
            batch = self._path_events.pop(binding_id)
            entry = current.get(binding_id)
            if entry is None or batch.empty():
                continue
            binding, root = entry
            try:
                summary = await project_path_events(db, binding.user_id, binding, root, batch)
                await db.commit()
                await self._flush_summary_event(db, binding, summary)
            except Exception as exc:
                await db.rollback()
                diag_log("filesync.watcher.project_path_events", exc)
                logger.warning(
                    "[worker] 文件单点投影出错，回退整树对账 binding=%s error_type=%s",
                    binding_id, type(exc).__name__,
                )
                self._pending_fallback.add(binding_id)

    async def _enqueue_pending_fallbacks(self, db, pending, current) -> None:
        """后台对账暂停时保留回退信号，targeted 路径事件仍由调用方继续投影。"""
        settings = get_settings()
        filesync = getattr(settings, "filesync", None)
        if not getattr(filesync, "background_reconcile_enabled", True):
            return
        targets = pending | self._pending_fallback
        for binding_id in targets & set(current):
            binding, _root = current[binding_id]
            try:
                await set_activity_reliability(db, binding.user_id, False)
                if binding.mode != "mirror_out":
                    await enqueue_reconcile(
                        db, binding, mode="snapshot_diff", reason="event_fallback",
                    )
                    await db.commit()
                pending.discard(binding_id)
                self._pending_fallback.discard(binding_id)
            except Exception as exc:
                # Rollback 可能使本轮 ORM 对象过期，升级剩余单点事件后
                # 在下一轮重查，避免复用过期 binding。
                await db.rollback()
                self._pending_fallback.add(binding_id)
                self._pending_fallback.update(self._path_events)
                current.clear()
                diag_log("filesync.watcher.enqueue_fallback", exc)
                logger.warning(
                    "[worker] 无法排队文件整树对账 binding=%s error_type=%s",
                    binding_id, type(exc).__name__,
                )
                break

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
                    self._pending_fallback.clear()
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
                        # 可补偿全集 = root 有效的全部绑定（含未挂监听的不活跃用户），
                        # 不是 watched 子集。日级兜底必须覆盖它，否则长期不活跃用户
                        # 的外部改动静默失联。
                        compensable_ids = set(current)
                        await self._drain_events(pending, compensable_ids)
                        await self._enqueue_pending_fallbacks(db, pending, current)
                        # 若整树回退被暂停，pending 信号保留；精确路径事件仍即时投影。
                        await self._project_path_events(db, current)
                        await db.commit()
                except FileSyncSidecarUnavailable:
                    async with db_session._SessionLocal() as db:
                        user_ids = set((await db.scalars(select(FileSyncBinding.user_id).where(
                            FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
                            FileSyncBinding.status == "active",
                        ))).all())
                        for user_id in user_ids:
                            await set_activity_reliability(db, user_id, False)
                        await db.commit()
                    pending.update(self._binding_roots)
                    self._pending_fallback |= set(self._path_events)
                    self._path_events.clear()
                    await self._sidecar.close()
                    # sidecar 进程内的 watch 状态随进程一起丢失；清空本地缓存，
                    # 下一轮启动后必须重新发送全部 watch，而不能只依赖补偿扫描。
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
