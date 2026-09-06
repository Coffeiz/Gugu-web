"""本地文件事实源的统一 TS watcher supervisor。

TS sidecar 只负责操作系统文件事件；本模块负责绑定生命周期、事件批处理、权限复核、
reconcile、journal/outbox 和优雅关闭。Shell 不参与文件刷新。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from sqlalchemy import select

from app.db import session as db_session
from app.models import FileSyncBinding, Workspace
from app.services.filesync.bindings import resolve_local_binding_root, sync_existing_binding
from app.services.filesync.outbox import deliver_file_event, enqueue_file_event
from app.services.filesync.protocol import FileSyncSource, create_binding, is_file_sync_enabled
from app.services.filesync.reconcile import _root_fingerprint
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
        compensation_interval: float = 60.0,
        sidecar: FileSyncSidecar | None = None,
    ):
        self.refresh_interval = refresh_interval
        self.compensation_interval = compensation_interval
        self._sidecar = sidecar or FileSyncSidecar()
        self._binding_roots: dict[int, Path] = {}
        self._last_refresh = 0.0
        self._last_compensation = 0.0

    async def _project(self, db, binding: FileSyncBinding, root: Path):
        if binding.mode == "mirror_out":
            return None
        result = await sync_existing_binding(
            db, binding.user_id, binding, root=root, allow_delete=True,
        )
        if not _has_changes(result.summary):
            return None
        return await enqueue_file_event(
            db, binding.user_id, operation="refresh",
            entity_ids=result.summary.entity_ids,
            source=FileSyncSource.LOCAL_DIRECTORY,
            revision=binding.revision,
        )

    async def _refresh_sidecar_bindings(
        self, db, bindings: list[FileSyncBinding], pending: set[int],
    ) -> dict[int, tuple[FileSyncBinding, Path]]:
        current: dict[int, tuple[FileSyncBinding, Path]] = {}
        for binding in bindings:
            root = await _binding_root(db, binding)
            if root is None or not root.exists() or not root.is_dir():
                continue
            current[binding.id] = (binding, root)
            if self._binding_roots.get(binding.id) != root:
                await self._sidecar.watch(binding.id, root)
                self._binding_roots[binding.id] = root
                pending.add(binding.id)
        for binding_id in set(self._binding_roots) - set(current):
            await self._sidecar.unwatch(binding_id)
            self._binding_roots.pop(binding_id, None)
            pending.discard(binding_id)
        return current

    async def _drain_events(self, pending: set[int], active_ids: set[int]) -> None:
        while True:
            event = await self._sidecar.next_event()
            if event is None:
                return
            if event.get("event") in {"needs_reconcile", "error"}:
                binding_id = event.get("binding_id")
                if isinstance(binding_id, int):
                    pending.add(binding_id)
                else:
                    pending.update(active_ids)
            elif event.get("event") == "change" and isinstance(event.get("binding_id"), int):
                pending.add(event["binding_id"])

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
                        current = await self._refresh_sidecar_bindings(db, bindings, pending)
                        active_ids = set(current)
                        await self._drain_events(pending, active_ids)
                        force = now - self._last_compensation >= self.compensation_interval
                        targets = set(pending)
                        if force:
                            targets.update(active_ids)
                        for binding_id in targets & active_ids:
                            binding, root = current[binding_id]
                            try:
                                event = await self._project(db, binding, root)
                                await db.commit()
                                if event is not None:
                                    await deliver_file_event(db, event)
                                    await db.commit()
                                pending.discard(binding_id)
                            except Exception as exc:
                                await db.rollback()
                                print(f"[worker] 文件同步投影出错: {type(exc).__name__}", flush=True)
                        if force:
                            self._last_compensation = now
                except FileSyncSidecarUnavailable:
                    pending.update(self._binding_roots)
                    await self._sidecar.close()
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    print(f"[worker] 文件同步 watcher 出错: {type(exc).__name__}", flush=True)
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self._sidecar.close()
