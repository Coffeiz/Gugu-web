"""手动异步文件核对执行器；实时 targeted 路径仍由 watcher 独立处理。"""
from __future__ import annotations

import asyncio
import os
import queue
import shutil
import stat
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from threading import Event
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.models import (
    File,
    FileSyncBinding,
    FileSyncConflict,
    FileSyncOutbox,
    FileSyncReconcileRun,
    Folder,
    StorageQuotaLedger,
    Workspace,
)
from app.services.filesync.inventory import stage_database_inventory
from app.services.filesync.jobs import (
    claim_next_run,
    finish_run,
    notify_run_changed,
    renew_run_lease,
    update_run_progress,
)
from app.services.filesync.outbox import deliver_file_event, enqueue_file_event
from app.services.filesync.protocol import FileSyncSource
from app.services.filesync.reconcile import _parse_directory_path, _root_fingerprint
from app.services.filesync.snapshots import snapshot_fingerprint
from app.services.filesync.scan import (
    ReconcileCandidate,
    ScanIncomplete,
    ScanManifest,
    ScanTimedOut,
    connect_manifest,
    default_manifest_budget,
    iter_reconcile_candidate_batches,
    manifest_exclusions_overlap_database,
    new_scan_stop_event,
    run_scan_in_thread,
    verify_changed_file_candidates,
    verify_missing_candidates,
)
from app.services.filesync.targeted import (
    PathEventBatch,
    PathProjectionOptions,
    project_path_events,
)
from app.services.storage import get_storage
from app.services.storage.folders import folder_dir_key
from app.services.workspaces import workspace_shell_supported

_COUNTER_KEYS = (
    "created", "updated", "moved", "deleted", "skipped", "conflicts", "failed",
    "foldersCreated", "foldersUpdated", "foldersDeleted", "plannedCreated", "plannedUpdated",
    "plannedDeleted", "exported", "permissionSkipped",
)
_POLL_SECONDS = 1.0
_LEASE_RENEW_SECONDS = 15.0
_DB_BATCH_SIZE = 128
_EXPORT_PAGE_SIZE = 128
_SCAN_TEMP_PREFIX = "gugu-filesync-"


@dataclass(frozen=True)
class _RunScope:
    run_id: UUID
    user_id: object
    binding_id: int
    root: Path
    mode: str
    workspace_id: int | None
    root_fingerprint: str
    gap_revision: int
    action: str
    allow_delete: bool


@dataclass
class _RunSignals:
    stop: Event
    cancelled: asyncio.Event
    timed_out: asyncio.Event
    interrupted: asyncio.Event
    lease_lost: asyncio.Event


class _RootRecoveryBlocked(ScanIncomplete):
    """目录身份不匹配且仍有关联内容时，拒绝自动重绑。"""


class _BindingRootUnavailable(ScanIncomplete):
    """绑定无法解析到有效 workspace 根目录。"""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="binding_root_unavailable")


def _empty_counts() -> dict[str, int]:
    return dict.fromkeys(_COUNTER_KEYS, 0)


def _candidate_in_supported_space(
    scope: _RunScope, relative_path: str, *, object_type: str | None = None,
) -> bool:
    """整用户根绑定只投影文件库管理的个人/项目树，保留其它物理目录不动。"""
    if scope.workspace_id is not None:
        return True
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(scope.user_id)).resolve()
    try:
        root_parts = scope.root.resolve().relative_to(user_root).parts
    except ValueError:
        return False
    relative_parts = Path(relative_path).parts if relative_path else ()
    parts = (*root_parts, *relative_parts)
    if len(parts) < 2 or parts[0] not in {"个人文件", "项目文件"}:
        return False
    if object_type != "folder":
        return True

    # 项目目录的年月层和项目根本身只是物理容器，不映射为 File Library Folder。
    # 旧同步逻辑会跳过这些目录；任务化投影必须同样跳过，不能把它们记成失败。
    return _parse_directory_path(user_root.joinpath(*parts), user_root) is not None


def _is_namespace_root_candidate(scope: _RunScope, relative_path: str) -> bool:
    if scope.workspace_id is not None or Path(relative_path).parts not in {
        ("个人文件",), ("项目文件",),
    }:
        return False
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(scope.user_id)).resolve()
    return scope.root.resolve() == user_root


def _publish_latest_progress(progress: queue.Queue, scanned: int, manifest_bytes: int) -> None:
    """进度只保留最新快照，扫描线程不能把事件循环拖成无界队列。"""
    value = (scanned, manifest_bytes)
    try:
        progress.put_nowait(value)
    except queue.Full:
        try:
            progress.get_nowait()
        except queue.Empty:
            pass
        try:
            progress.put_nowait(value)
        except queue.Full:
            pass


async def _cleanup_stale_scan_artifacts(session_factory) -> None:
    """只清理命名含任务 ID 且数据库已确认非活动的私有扫描目录。"""
    temp_root = Path(tempfile.gettempdir())
    try:
        directories = tuple(temp_root.iterdir())
    except OSError as exc:
        diag_log("filesync.temp_cleanup", exc)
        return
    for directory in directories:
        if (
            directory.is_symlink()
            or not directory.is_dir()
            or not directory.name.startswith(_SCAN_TEMP_PREFIX)
        ):
            continue
        try:
            metadata = directory.stat(follow_symlinks=False)
        except OSError:
            continue
        process_uid = getattr(os, "getuid", lambda: metadata.st_uid)()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != process_uid
            or metadata.st_mode & 0o077
        ):
            continue
        run_id_text = directory.name[len(_SCAN_TEMP_PREFIX):len(_SCAN_TEMP_PREFIX) + 36]
        try:
            run_id = UUID(run_id_text)
        except ValueError:
            continue
        async with session_factory() as db:
            run = await db.get(FileSyncReconcileRun, run_id)
            active = run is not None and run.status in {"running", "cancelling"}
            await db.rollback()
        if active:
            continue
        try:
            shutil.rmtree(directory)
        except OSError as exc:
            diag_log("filesync.temp_cleanup", exc)


def _manifest_path_prefix(root: Path) -> str:
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    return root.resolve().relative_to(storage_root).as_posix().rstrip("/") + "/"


async def _workspace_has_file_records(
    db: AsyncSession, *, user_id, workspace: Workspace, root: Path,
) -> bool:
    """保守检查 workspace 关联及物理路径下是否仍有任何 File/Folder 行。"""
    if workspace.kind == "directory" and workspace.directory_id is not None:
        related_folder = select(Folder.id).where(
            Folder.user_id == user_id,
            Folder.workspace_directory_id == workspace.directory_id,
        ).limit(1)
        related_file = select(File.id).where(
            File.user_id == user_id,
            File.workspace_directory_id == workspace.directory_id,
        ).limit(1)
    elif workspace.kind == "project" and workspace.project_id is not None:
        related_folder = select(Folder.id).where(
            Folder.user_id == user_id,
            Folder.project_id == workspace.project_id,
        ).limit(1)
        related_file = select(File.id).where(
            File.user_id == user_id,
            File.project_id == workspace.project_id,
        ).limit(1)
    else:
        # Folder workspace 引用失效时无法证明安全；按已有记录处理并拒绝恢复。
        return True

    storage_prefix = _manifest_path_prefix(root)
    path_file = select(File.id).where(
        File.user_id == user_id,
        File.storage_key.startswith(storage_prefix, autoescape=True),
    ).limit(1)
    return (
        await db.scalar(related_folder) is not None
        or await db.scalar(related_file) is not None
        or await db.scalar(path_file) is not None
    )


async def _ensure_safe_empty_workspace_root(
    db: AsyncSession, *, user_id, workspace_id: int | None, root: Path,
) -> bool:
    """只接受存储范围内、物理与数据库都为空的有效 workspace 根目录。"""
    if workspace_id is None:
        return False
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    expected_user_root = storage_root / str(user_id)
    try:
        relative_to_user = root.resolve().relative_to(expected_user_root)
    except ValueError:
        return False
    if not relative_to_user.parts or root.is_symlink():
        return False
    if any(parent.is_symlink() for parent in (root, *root.parents) if parent.exists()):
        return False
    workspace = await db.scalar(select(Workspace).where(
        Workspace.id == workspace_id,
        Workspace.user_id == user_id,
        Workspace.enabled.is_(True),
    ))
    if workspace is None or await _workspace_has_file_records(db, user_id=user_id, workspace=workspace, root=root):
        return False

    if root.exists():
        if not root.is_dir() or root.is_symlink():
            return False
        try:
            if next(root.iterdir(), None) is not None:
                return False
        except OSError:
            return False

    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return root.is_dir() and not root.is_symlink()


async def _is_canonical_existing_workspace_root(
    db: AsyncSession, *, user_id, workspace_id: int | None, root: Path,
) -> bool:
    """验证现存根目录仍由当前有效 Workspace 唯一解析，不触碰目录内容。"""
    if workspace_id is None or not root.exists() or not root.is_dir() or root.is_symlink():
        return False
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    expected_user_root = storage_root / str(user_id)
    try:
        relative_to_user = root.resolve().relative_to(expected_user_root)
    except ValueError:
        return False
    if not relative_to_user.parts:
        return False
    if any(parent.is_symlink() for parent in (root, *root.parents) if parent.exists()):
        return False
    workspace = await db.scalar(select(Workspace).where(
        Workspace.id == workspace_id,
        Workspace.user_id == user_id,
        Workspace.enabled.is_(True),
    ))
    return workspace is not None


async def _load_scope(session_factory, run_id: UUID) -> _RunScope:
    from app.services.filesync.watcher import _binding_root

    async with session_factory() as db:
        run = await db.get(FileSyncReconcileRun, run_id)
        if run is None:
            raise LookupError("对账任务不存在")
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.id == run.binding_id,
            FileSyncBinding.user_id == run.user_id,
            FileSyncBinding.status == "active",
        ))
        if binding is None or binding.root_fingerprint != run.root_fingerprint:
            raise ScanIncomplete("同步绑定已变化", code="binding_changed")
        root = await _binding_root(db, binding)
        if root is None:
            raise _BindingRootUnavailable("同步绑定没有有效的工作区根目录")
        current_fingerprint = _root_fingerprint(root)
        if (
            (not root.is_dir() or current_fingerprint != run.root_fingerprint)
            and run.action in {"repair", "initialize"}
        ):
            if root.is_dir():
                # 根目录已由当前有效 Workspace 元数据解析，刷新的是绑定指纹，
                # 不重建目录、不删除 File/Folder 记录；后续修复默认也不允许删除。
                recovered = await _is_canonical_existing_workspace_root(
                    db, user_id=run.user_id, workspace_id=binding.workspace_id, root=root,
                )
            else:
                # 缺失目录只有在物理目录与 DB 关联记录都为空时才允许重建。
                recovered = await _ensure_safe_empty_workspace_root(
                    db, user_id=run.user_id, workspace_id=binding.workspace_id, root=root,
                )
            if not recovered:
                raise _RootRecoveryBlocked("绑定目录路径已变化或缺失且仍有内容，为保护旧数据已停止自动重绑")
            current_fingerprint = _root_fingerprint(root)
            binding.root_fingerprint = current_fingerprint
            binding.revision += 1
            run.root_fingerprint = current_fingerprint
            run.binding_revision = binding.revision
            run.revision += 1
            run.updated_at = now_utc()
            await db.commit()
            await notify_run_changed(run, coalesce=True)
        if not root.is_dir() or root.is_symlink() or current_fingerprint != run.root_fingerprint:
            raise _BindingRootUnavailable("同步根目录不存在、不可访问或身份已变化")
        scope = _RunScope(
            run_id=run.id,
            user_id=run.user_id,
            binding_id=binding.id,
            root=root,
            mode=binding.mode,
            workspace_id=binding.workspace_id,
            root_fingerprint=run.root_fingerprint,
            gap_revision=run.gap_revision,
            action=run.action,
            allow_delete=run.allow_delete,
        )
        await db.rollback()
        return scope


async def _monitor_run(
    session_factory,
    run_id: UUID,
    worker_id: str,
    worker_stop: asyncio.Event,
    signals: _RunSignals,
) -> None:
    next_renew = asyncio.get_running_loop().time() + _LEASE_RENEW_SECONDS
    loop = asyncio.get_running_loop()
    while not worker_stop.is_set() and not signals.stop.is_set():
        try:
            async with session_factory() as db:
                run = await db.get(FileSyncReconcileRun, run_id)
                if run is None or run.lease_owner != worker_id or run.status not in {"running", "cancelling"}:
                    signals.lease_lost.set()
                    signals.stop.set()
                    return
                if run.cancel_requested or run.status == "cancelling":
                    signals.cancelled.set()
                    signals.stop.set()
                    await db.rollback()
                    return
                if run.deadline_at is not None and run.deadline_at <= now_utc():
                    signals.timed_out.set()
                    signals.stop.set()
                    await db.rollback()
                    return
                if loop.time() >= next_renew:
                    if not await renew_run_lease(db, run_id, worker_id):
                        signals.lease_lost.set()
                        signals.stop.set()
                        return
                    next_renew = loop.time() + _LEASE_RENEW_SECONDS
                else:
                    await db.rollback()
        except asyncio.CancelledError:
            signals.interrupted.set()
            signals.stop.set()
            raise
        except Exception as exc:
            # DB 短暂不可用时停止产生新副作用；当前线程会协作退出后再释放任务。
            diag_log("filesync.run_monitor", exc)
            signals.interrupted.set()
            signals.stop.set()
            return
        try:
            await asyncio.wait_for(worker_stop.wait(), timeout=_POLL_SECONDS)
        except TimeoutError:
            pass
    if worker_stop.is_set():
        signals.interrupted.set()
        signals.stop.set()


async def _check_scope_before_batch(session_factory, scope: _RunScope, stop: Event) -> str:
    from app.services.filesync.watcher import _binding_root

    if stop.is_set():
        raise InterruptedError("核对任务已停止")
    async with session_factory() as db:
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.id == scope.binding_id,
            FileSyncBinding.user_id == scope.user_id,
            FileSyncBinding.status == "active",
        ).with_for_update())
        if binding is None or binding.root_fingerprint != scope.root_fingerprint:
            raise ScanIncomplete("同步绑定已变化", code="binding_changed")
        current_root = await _binding_root(db, binding)
        if current_root is None or _root_fingerprint(current_root) != scope.root_fingerprint:
            raise _BindingRootUnavailable("同步根目录不存在、不可访问或身份已变化")
        await db.rollback()
    return _manifest_path_prefix(scope.root)


async def _current_path_conflicts(
    db: AsyncSession, binding_id: int, paths: list[str],
) -> set[str]:
    if not paths:
        return set()
    rows = await db.scalars(select(FileSyncConflict.relative_path).where(
        FileSyncConflict.binding_id == binding_id,
        FileSyncConflict.status == "pending",
        FileSyncConflict.relative_path.in_(paths),
    ))
    return set(rows.all())


async def _current_candidates(
    db: AsyncSession,
    scope: _RunScope,
    candidates: list[ReconcileCandidate],
    storage_prefix: str,
) -> set[int]:
    """按批锁定并复核候选版本，避免每条路径单独往返数据库。"""
    valid: set[int] = set()
    file_creates = [
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if candidate.object_type == "file" and candidate.operation == "create"
    ]
    if file_creates:
        expected_keys = {
            storage_prefix + candidate.relative_path
            for _, candidate in file_creates
        }
        existing_keys = set((await db.scalars(
            select(File.storage_key).where(
                File.user_id == scope.user_id,
                File.storage_key.in_(expected_keys),
                File.deleted_at.is_(None),
            ).order_by(File.storage_key).with_for_update()
        )).all())
        valid.update(
            index for index, candidate in file_creates
            if storage_prefix + candidate.relative_path not in existing_keys
        )

    file_rows = [
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if candidate.object_type == "file"
        and candidate.operation != "create"
        and candidate.object_id is not None
    ]
    if file_rows:
        rows = (await db.scalars(
            select(File).where(
                File.id.in_({candidate.object_id for _, candidate in file_rows}),
                File.user_id == scope.user_id,
                File.deleted_at.is_(None),
            ).order_by(File.id).with_for_update()
        )).all()
        rows_by_id = {row.id: row for row in rows}
        valid.update(
            index for index, candidate in file_rows
            if (row := rows_by_id.get(candidate.object_id)) is not None
            and row.version == candidate.object_version
            and row.storage_key == storage_prefix + candidate.relative_path
        )

    valid.update(
        index for index, candidate in enumerate(candidates)
        if candidate.object_type == "folder" and candidate.operation == "create"
    )  # 活动范围唯一约束会与实时创建安全汇合。
    folder_rows = [
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if candidate.object_type == "folder"
        and candidate.operation != "create"
        and candidate.object_id is not None
    ]
    if folder_rows:
        rows = (await db.scalars(
            select(Folder).where(
                Folder.id.in_({candidate.object_id for _, candidate in folder_rows}),
                Folder.user_id == scope.user_id,
                Folder.deleted_at.is_(None),
            ).order_by(Folder.id).with_for_update()
        )).all()
        rows_by_id = {row.id: row for row in rows}
        storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
        for index, candidate in folder_rows:
            row = rows_by_id.get(candidate.object_id)
            if row is None or row.version != candidate.object_version:
                continue
            key = await folder_dir_key(db, scope.user_id, row)
            if key is None:
                continue
            try:
                relative = (storage_root / key).resolve().relative_to(scope.root.resolve()).as_posix()
            except (OSError, ValueError):
                continue
            if relative == candidate.relative_path:
                valid.add(index)
    return valid


def _count_plans(counts: dict[str, int], candidates: list[ReconcileCandidate]) -> None:
    for candidate in candidates:
        if candidate.operation == "create":
            counts["plannedCreated"] += 1
        elif candidate.operation == "update":
            counts["plannedUpdated"] += 1
        elif candidate.operation == "delete":
            counts["plannedDeleted"] += 1
        elif candidate.operation in {"ambiguous", "conflict"}:
            counts["conflicts"] += 1


async def _project_batch(
    session_factory,
    scope: _RunScope,
    worker_id: str,
    candidates: list[ReconcileCandidate],
    *,
    storage_prefix: str,
    verified_files: dict[str, tuple[int, int, int, str] | None],
    missing_paths: set[str],
    counts: dict[str, int],
    stop: Event,
    record_repair_change_deltas: bool = False,
) -> bool:
    if stop.is_set():
        raise InterruptedError("核对任务已停止")
    async with session_factory() as db:
        run = await db.scalar(select(FileSyncReconcileRun).where(
            FileSyncReconcileRun.id == scope.run_id,
            FileSyncReconcileRun.lease_owner == worker_id,
            FileSyncReconcileRun.status.in_(("running", "cancelling")),
        ).with_for_update())
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.id == scope.binding_id,
            FileSyncBinding.user_id == scope.user_id,
            FileSyncBinding.status == "active",
        ).with_for_update())
        if run is None or binding is None or binding.root_fingerprint != scope.root_fingerprint:
            await db.rollback()
            return False
        pending_conflicts = await _current_path_conflicts(
            db, scope.binding_id, [item.relative_path for item in candidates],
        )
        current_candidates = await _current_candidates(
            db, scope, candidates, storage_prefix,
        )
        batch = PathEventBatch()
        observed_folders: dict[str, str] = {}
        verified_files_for_batch: dict[str, tuple[int, int, int, str]] = {}
        transaction_counts: dict[str, int] = {}
        for index, candidate in enumerate(candidates):
            if stop.is_set():
                await db.rollback()
                raise InterruptedError("核对任务已停止")
            if not _candidate_in_supported_space(
                scope, candidate.relative_path, object_type=candidate.object_type,
            ):
                if _is_namespace_root_candidate(scope, candidate.relative_path):
                    continue
                # 整用户根目录还包含 workspace、运行时缓存等非 File/Folder
                # 命名空间；它们不属于本绑定的文件库投影范围，也不算修复遗漏。
                continue
            if candidate.operation == "ambiguous":
                continue
            if candidate.relative_path in pending_conflicts:
                if candidate.operation != "conflict":
                    transaction_counts["conflicts"] = transaction_counts.get("conflicts", 0) + 1
                continue
            if candidate.operation == "conflict":
                if index not in current_candidates:
                    transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + 1
                    continue
                db.add(FileSyncConflict(
                    binding_id=scope.binding_id,
                    user_id=scope.user_id,
                    relative_path=candidate.relative_path,
                    source=FileSyncSource.LOCAL_DIRECTORY,
                    baseline_fingerprint=candidate.baseline_fingerprint,
                    local_fingerprint=candidate.observed_fingerprint,
                    remote_fingerprint=(
                        snapshot_fingerprint(
                            scope.user_id, scope.binding_id, candidate.relative_path,
                        ) or candidate.baseline_fingerprint
                    ),
                    status="pending",
                ))
                continue
            if scope.action == "initialize" and candidate.operation == "update":
                transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + 1
                continue
            if candidate.operation in {"create", "update"} and candidate.object_type == "file":
                verified = verified_files.get(candidate.relative_path)
                if verified is None:
                    transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + 1
                    continue
            else:
                verified = None
            if candidate.operation == "delete" and candidate.relative_path not in missing_paths:
                transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + 1
                continue
            if index not in current_candidates:
                transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + 1
                continue
            if candidate.operation == "delete" and (
                scope.action != "repair" or not scope.allow_delete
            ):
                if candidate.object_type == "file":
                    db.add(FileSyncConflict(
                        binding_id=scope.binding_id,
                        user_id=scope.user_id,
                        relative_path=candidate.relative_path,
                        source=FileSyncSource.LOCAL_DIRECTORY,
                        baseline_fingerprint=candidate.baseline_fingerprint,
                        local_fingerprint=None,
                        remote_fingerprint=(
                            snapshot_fingerprint(
                                scope.user_id, scope.binding_id, candidate.relative_path,
                            ) or candidate.baseline_fingerprint
                        ),
                        status="pending",
                    ))
                    transaction_counts["conflicts"] = transaction_counts.get("conflicts", 0) + 1
                else:
                    transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + 1
                continue
            if candidate.object_type == "file" and candidate.operation in {"create", "update"}:
                batch.changed.add(candidate.relative_path)
                if candidate.operation == "create":
                    batch.created_files.add(candidate.relative_path)
            elif candidate.object_type == "folder" and candidate.operation in {"create", "update"}:
                batch.folders_created.add(candidate.relative_path)
                if candidate.observed_fingerprint:
                    observed_folders[candidate.relative_path] = candidate.observed_fingerprint
            elif candidate.object_type == "file" and candidate.operation == "delete":
                batch.deleted.add(candidate.relative_path)
            elif candidate.object_type == "folder" and candidate.operation == "delete":
                batch.folders_deleted.add(candidate.relative_path)
            if verified is not None:
                verified_files_for_batch[candidate.relative_path] = verified

        summary = None
        if not stop.is_set() and not batch.empty():
            summary = await project_path_events(
                db,
                scope.user_id,
                binding,
                scope.root,
                batch,
                options=PathProjectionOptions(
                    allow_delete=scope.action == "repair" and scope.allow_delete,
                    record_quota_deltas=record_repair_change_deltas,
                    verified_files=verified_files_for_batch,
                    observed_folders=observed_folders,
                ),
            )
            transaction_counts["created"] = summary.created
            transaction_counts["updated"] = summary.updated
            transaction_counts["moved"] = summary.moved
            transaction_counts["deleted"] = summary.deleted
            transaction_counts["foldersCreated"] = summary.folders_created
            transaction_counts["foldersUpdated"] = summary.folders_updated
            transaction_counts["foldersDeleted"] = summary.folders_deleted
            transaction_counts["failed"] = summary.rejected
            for reason, count in summary.rejection_reasons:
                transaction_counts[f"rejected_{reason}"] = count
            if summary.rejected:
                transaction_counts["skipped"] = transaction_counts.get("skipped", 0) + summary.rejected
            if summary.entity_ids or summary.conflicts:
                outbox = await enqueue_file_event(
                    db,
                    scope.user_id,
                    operation="refresh",
                    entity_ids=summary.entity_ids,
                    source=FileSyncSource.LOCAL_DIRECTORY,
                    revision=binding.revision,
                )
            else:
                outbox = None
        else:
            outbox = None
        if stop.is_set():
            await db.rollback()
            raise InterruptedError("核对任务已停止")
        updated = dict(counts)
        for key, value in transaction_counts.items():
            updated[key] = int(updated.get(key, 0)) + value
        run.result_counts = updated
        run.revision += 1
        run.updated_at = now_utc()
        await db.commit()
        await notify_run_changed(run, coalesce=True)
        counts.clear()
        counts.update(updated)
        if outbox is not None:
            # 业务投影和已应用计数已提交；资源刷新只是可重试通知，失败不能
            # 让外层任务收尾用旧计数覆盖已经提交的部分结果。
            try:
                async with session_factory() as notify_db:
                    persisted_outbox = await notify_db.get(FileSyncOutbox, outbox.id)
                    if persisted_outbox is not None:
                        await deliver_file_event(notify_db, persisted_outbox)
                        await notify_db.commit()
            except Exception as exc:
                diag_log("filesync.run_outbox", exc)
        return True


async def _execute_scope(
    session_factory,
    executor: ThreadPoolExecutor,
    scope: _RunScope,
    worker_id: str,
    worker_stop: asyncio.Event,
    signals: _RunSignals,
) -> tuple[str, str | None, dict[str, int]]:
    settings = get_settings().filesync
    max_manifest_bytes, commit_entries = default_manifest_budget()
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(scope.user_id)).resolve()
    record_repair_change_deltas = False
    included_root_entries = (
        frozenset({"个人文件", "项目文件"})
        if scope.workspace_id is None and scope.root.resolve() == user_root
        else None
    )
    temp_directory = Path(tempfile.mkdtemp(prefix=f"{_SCAN_TEMP_PREFIX}{scope.run_id}-"))
    manifest: ScanManifest | None = None
    counts = _empty_counts()
    try:
        if scope.mode == "mirror_out":
            return await _execute_mirror_out(
                session_factory, scope, worker_id, signals,
            )
        if scope.action == "mirror_out":
            raise ScanIncomplete("反向导出任务与绑定模式不匹配")
        if not workspace_shell_supported():
            raise ScanIncomplete("当前存储模式不支持本地文件同步")
        if scope.action == "repair":
            from app.services.storage.quota_ledger import FILE_LIBRARY

            async with session_factory() as db:
                record_repair_change_deltas = await db.scalar(select(StorageQuotaLedger.id).where(
                    StorageQuotaLedger.user_id == scope.user_id,
                    StorageQuotaLedger.category == FILE_LIBRARY,
                )) is not None
                await db.rollback()
        storage_prefix = await _check_scope_before_batch(session_factory, scope, signals.stop)
        async with session_factory() as db:
            await update_run_progress(
                db, scope.run_id, worker_id, stage="scanning", result_counts=counts,
            )
        async with session_factory() as db:
            deadline = await db.scalar(select(FileSyncReconcileRun.deadline_at).where(
                FileSyncReconcileRun.id == scope.run_id,
                FileSyncReconcileRun.lease_owner == worker_id,
            ))
            await db.rollback()
        if deadline is None:
            raise ScanIncomplete("核对任务期限无效")
        progress: queue.Queue[tuple[int, int]] = queue.Queue(maxsize=1)
        loop = asyncio.get_running_loop()
        scan_task = asyncio.create_task(run_scan_in_thread(
            executor,
            scope.root,
            temp_directory=temp_directory,
            stop_event=signals.stop,
            max_manifest_bytes=max_manifest_bytes,
            timeout_seconds=max(0.01, (deadline - now_utc()).total_seconds()),
            commit_entries=commit_entries,
            on_progress=partial(_publish_latest_progress, progress),
            included_root_entries=included_root_entries,
        ))
        last_progress = (-1, -1)
        while not scan_task.done():
            await asyncio.wait({scan_task}, timeout=0.5)
            latest_progress = last_progress
            while True:
                try:
                    latest_progress = progress.get_nowait()
                except queue.Empty:
                    break
            if latest_progress != last_progress:
                last_progress = latest_progress
                async with session_factory() as db:
                    await update_run_progress(
                        db, scope.run_id, worker_id, stage="scanning",
                        scanned_count=last_progress[0],
                    )
        manifest = await scan_task
        if signals.stop.is_set():
            raise InterruptedError("核对任务已停止")
        file_count, folder_count = await stage_database_inventory(
            session_factory,
            user_id=scope.user_id,
            binding_id=scope.binding_id,
            root=scope.root,
            manifest=manifest,
            max_manifest_bytes=max_manifest_bytes,
            stop_event=signals.stop,
            included_root_entries=included_root_entries,
        )
        if manifest_exclusions_overlap_database(manifest):
            raise ScanIncomplete(
                "符号链接遮蔽了文件库记录；为保护旧记录未应用本次扫描",
                code="scan_unsupported_symlink",
            )
        if manifest.scanned_count == 0 and file_count + folder_count:
            raise ScanIncomplete(
                "文件库记录仍存在，但完整文件库范围为空；未应用扫描结果",
                code="scan_empty_with_existing_records",
            )
        storage_prefix = await _check_scope_before_batch(session_factory, scope, signals.stop)
        counts = _empty_counts()
        counts["permissionSkipped"] = manifest.permission_excluded_count
        async with session_factory() as db:
            run = await db.get(FileSyncReconcileRun, scope.run_id)
            if run is None or run.lease_owner != worker_id:
                raise InterruptedError("任务执行权已失效")
            run.stage = "comparing"
            run.scanned_count = manifest.scanned_count
            run.result_counts = counts
            run.revision += 1
            await db.commit()
            await notify_run_changed(run, coalesce=True)

        for candidates in iter_reconcile_candidate_batches(manifest, batch_size=_DB_BATCH_SIZE):
            if worker_stop.is_set() or signals.stop.is_set():
                raise InterruptedError("核对任务已停止")
            if now_utc() >= (await _current_deadline(session_factory, scope.run_id)):
                signals.timed_out.set()
                signals.stop.set()
                raise ScanTimedOut("核对任务超过执行期限")
            _count_plans(counts, candidates)
            loop = asyncio.get_running_loop()
            verify_future = loop.run_in_executor(
                executor,
                partial(verify_changed_file_candidates, scope.root, candidates, stop_event=signals.stop),
            )
            missing_future = loop.run_in_executor(
                executor,
                partial(verify_missing_candidates, scope.root, candidates, stop_event=signals.stop),
            )
            verified_files, missing_paths = await asyncio.gather(verify_future, missing_future)
            if signals.stop.is_set():
                raise InterruptedError("核对任务已停止")
            if scope.action == "dry_run":
                async with session_factory() as db:
                    run = await db.scalar(select(FileSyncReconcileRun).where(
                        FileSyncReconcileRun.id == scope.run_id,
                        FileSyncReconcileRun.lease_owner == worker_id,
                        FileSyncReconcileRun.status == "running",
                    ).with_for_update())
                    if run is None:
                        raise InterruptedError("任务执行权已失效")
                    conflicts = await _current_path_conflicts(
                        db, scope.binding_id, [item.relative_path for item in candidates],
                    )
                    counts["conflicts"] += sum(
                        1 for item in candidates
                        if item.relative_path in conflicts
                        and item.operation not in {"ambiguous", "conflict"}
                    )
                    counts["skipped"] += sum(
                        1 for item in candidates
                        if item.operation == "delete" or item.operation == "update"
                    )
                    run.result_counts = counts
                    run.revision += 1
                    run.updated_at = now_utc()
                    await db.commit()
                    await notify_run_changed(run, coalesce=True)
            else:
                projected = await _project_batch(
                    session_factory,
                    scope,
                    worker_id,
                    candidates,
                    storage_prefix=storage_prefix,
                    verified_files=verified_files,
                    missing_paths=missing_paths,
                    counts=counts,
                    stop=signals.stop,
                    record_repair_change_deltas=record_repair_change_deltas,
                )
                if not projected:
                    raise InterruptedError("任务执行权已失效")
            async with session_factory() as db:
                run = await db.get(FileSyncReconcileRun, scope.run_id)
                if run is None or run.lease_owner != worker_id:
                    raise InterruptedError("任务执行权已失效")
                run.stage = "projecting" if scope.action != "dry_run" else "comparing"
                run.result_counts = counts
                run.revision += 1
                run.updated_at = now_utc()
                await db.commit()
                await notify_run_changed(run, coalesce=True)

        if signals.stop.is_set():
            raise InterruptedError("核对任务已停止")
        if scope.action == "repair" and scope.allow_delete:
            async with session_factory() as db:
                binding = await db.scalar(select(FileSyncBinding).where(
                    FileSyncBinding.id == scope.binding_id,
                    FileSyncBinding.user_id == scope.user_id,
                    FileSyncBinding.status == "active",
                ))
                if binding is None or _root_fingerprint(scope.root) != scope.root_fingerprint:
                    raise ScanIncomplete("同步范围已变化", code="binding_changed")
        if now_utc() >= await _current_deadline(session_factory, scope.run_id):
            signals.timed_out.set()
            signals.stop.set()
            raise ScanTimedOut("核对任务超过执行期限")
        if counts["permissionSkipped"]:
            # 可读范围的投影可以保留，但未覆盖权限受限子树不能声明完整核对成功。
            return "failed", "scan_permission_denied", counts
        if counts["failed"]:
            return "failed", "path_projection_failed", counts
        return "succeeded", None, counts
    except ScanTimedOut:
        return "failed", "execution_timeout", counts
    except InterruptedError:
        if signals.cancelled.is_set():
            return "cancelled", None, counts
        if signals.timed_out.is_set():
            return "failed", "execution_timeout", counts
        if signals.lease_lost.is_set():
            return "failed", "lease_lost", counts
        return "failed", "worker_interrupted", counts
    except ScanIncomplete as exc:
        diag_log("filesync.reconcile_scan", exc)
        return "failed", exc.code, counts
    except Exception as exc:
        diag_log("filesync.reconcile_run", exc)
        return "failed", "reconcile_failed", counts
    finally:
        if manifest is not None:
            manifest.close()
        try:
            temp_directory.rmdir()
        except OSError:
            pass


async def _execute_mirror_out(
    session_factory,
    scope: _RunScope,
    worker_id: str,
    signals: _RunSignals,
) -> tuple[str, str | None, dict[str, int]]:
    """保留 mirror_out 的单向导出语义；文件分页读取，不导入本地内容。"""
    from app.services.filesync.watcher import _binding_root

    settings = get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(scope.user_id)).resolve()
    storage = get_storage()
    counts = _empty_counts()
    last_id = 0
    try:
        while not signals.stop.is_set():
            async with session_factory() as db:
                binding = await db.scalar(select(FileSyncBinding).where(
                    FileSyncBinding.id == scope.binding_id,
                    FileSyncBinding.user_id == scope.user_id,
                    FileSyncBinding.status == "active",
                ))
                if (
                    binding is None
                    or binding.mode != "mirror_out"
                    or binding.root_fingerprint != scope.root_fingerprint
                ):
                    raise ScanIncomplete("反向导出绑定已变化")
                root = await _binding_root(db, binding)
                if root is None or _root_fingerprint(root) != scope.root_fingerprint:
                    raise ScanIncomplete("反向导出目录不可用")
                rows = (await db.execute(
                    select(File.id, File.storage_key, File.version)
                    .where(
                        File.user_id == scope.user_id,
                        File.deleted_at.is_(None),
                        File.id > last_id,
                    )
                    .order_by(File.id)
                    .limit(_EXPORT_PAGE_SIZE)
                )).all()
                await db.rollback()
            if not rows:
                break
            last_id = rows[-1].id
            for file_id, storage_key, version in rows:
                if signals.stop.is_set():
                    break
                source = (storage_root / storage_key).resolve()
                try:
                    relative = source.relative_to(user_root)
                    destination = (root / relative).resolve()
                    destination.relative_to(root.resolve())
                except (OSError, ValueError):
                    counts["failed"] += 1
                    continue
                if source == destination and destination.is_file():
                    continue
                if not await storage.exists(storage_key):
                    counts["failed"] += 1
                    continue
                async with session_factory() as db:
                    current = await db.scalar(select(File.id).where(
                        File.id == file_id,
                        File.user_id == scope.user_id,
                        File.version == version,
                        File.deleted_at.is_(None),
                    ))
                    await db.rollback()
                if current is None:
                    counts["skipped"] += 1
                    continue
                destination_key = destination.relative_to(storage_root).as_posix()
                try:
                    await storage.copy(storage_key, destination_key)
                except (OSError, ValueError):
                    counts["failed"] += 1
                    continue
                counts["exported"] += 1
            async with session_factory() as db:
                run = await db.scalar(select(FileSyncReconcileRun).where(
                    FileSyncReconcileRun.id == scope.run_id,
                    FileSyncReconcileRun.lease_owner == worker_id,
                ).with_for_update())
                if run is None or signals.stop.is_set():
                    await db.rollback()
                    break
                run.scanned_count += len(rows)
                run.result_counts = dict(counts)
                run.stage = "projecting"
                run.revision += 1
                run.updated_at = now_utc()
                await db.commit()
                await notify_run_changed(run, coalesce=True)
        if signals.stop.is_set():
            if signals.cancelled.is_set():
                return "cancelled", None, counts
            if signals.timed_out.is_set():
                return "failed", "execution_timeout", counts
            return "failed", "worker_interrupted", counts
        if now_utc() >= await _current_deadline(session_factory, scope.run_id):
            signals.timed_out.set()
            signals.stop.set()
            return "failed", "execution_timeout", counts
        return _mirror_out_terminal_state(counts)
    except ScanIncomplete as exc:
        diag_log("filesync.mirror_out", exc)
        return "failed", "binding_unavailable", counts
    except Exception as exc:
        diag_log("filesync.mirror_out", exc)
        return "failed", "mirror_out_failed", counts


def _mirror_out_terminal_state(counts: dict[str, int]) -> tuple[str, str | None, dict[str, int]]:
    """只有所有候选均成功导出时，反向导出任务才报告 succeeded。"""
    if counts["failed"]:
        return "failed", "mirror_out_partial_failure", counts
    return "succeeded", None, counts


async def _current_deadline(session_factory, run_id: UUID):
    async with session_factory() as db:
        value = await db.scalar(select(FileSyncReconcileRun.deadline_at).where(
            FileSyncReconcileRun.id == run_id,
        ))
        await db.rollback()
        return value or now_utc()


async def _run_claimed(
    session_factory,
    executor: ThreadPoolExecutor,
    run: FileSyncReconcileRun,
    worker_id: str,
    worker_stop: asyncio.Event,
) -> None:
    scope: _RunScope | None = None
    signals = _RunSignals(
        stop=new_scan_stop_event(),
        cancelled=asyncio.Event(),
        timed_out=asyncio.Event(),
        interrupted=asyncio.Event(),
        lease_lost=asyncio.Event(),
    )
    monitor = asyncio.create_task(
        _monitor_run(session_factory, run.id, worker_id, worker_stop, signals),
        name=f"filesync-run-monitor-{str(run.id)[:8]}",
    )
    try:
        try:
            scope = await _load_scope(session_factory, run.id)
            status, error_code, counts = await _execute_scope(
                session_factory, executor, scope, worker_id, worker_stop, signals,
            )
            # 执行主体已经返回，先通知租约监控退出，再等待它收尾；反序会让
            # 成功任务永远卡在 monitor 的轮询循环中。
            signals.stop.set()
        except _RootRecoveryBlocked as exc:
            diag_log("filesync.root_recovery_blocked", exc)
            status, error_code, counts = "failed", "root_recovery_blocked", _empty_counts()
        except _BindingRootUnavailable as exc:
            diag_log("filesync.binding_root_unavailable", exc)
            status, error_code, counts = "failed", "binding_root_unavailable", _empty_counts()
        except ScanIncomplete as exc:
            diag_log("filesync.reconcile_scope", exc)
            status, error_code, counts = (
                "failed",
                "binding_unavailable" if exc.code == "scan_incomplete" else exc.code,
                _empty_counts(),
            )
        except asyncio.CancelledError:
            signals.interrupted.set()
            signals.stop.set()
            status, error_code, counts = "failed", "worker_interrupted", _empty_counts()
            raise
        except Exception as exc:
            diag_log("filesync.reconcile_runner", exc)
            status, error_code, counts = "failed", "reconcile_failed", _empty_counts()
        signals.stop.set()
        await monitor
        if signals.cancelled.is_set():
            status, error_code = "cancelled", None
        elif signals.timed_out.is_set():
            status, error_code = "failed", "execution_timeout"
        elif signals.interrupted.is_set() and status == "succeeded":
            status, error_code = "failed", "worker_interrupted"
        async with session_factory() as db:
            current = await db.scalar(select(FileSyncReconcileRun).where(
                FileSyncReconcileRun.id == run.id,
                FileSyncReconcileRun.lease_owner == worker_id,
            ).with_for_update())
            if current is not None:
                current.result_counts = counts
                current.revision += 1
                current.updated_at = now_utc()
                await db.commit()
            else:
                await db.rollback()
        async with session_factory() as db:
            await finish_run(
                db, run.id, worker_id, status=status, error_code=error_code,
                stage="finished" if status == "succeeded" else status,
                reconciliation_complete=(
                    status == "succeeded"
                    and scope is not None
                    and scope.action in {"repair", "initialize"}
                ),
                requeue_mirror_out_changes=(
                    status == "succeeded"
                    and scope is not None
                    and scope.action == "mirror_out"
                ),
            )
    finally:
        signals.stop.set()
        if not monitor.done():
            monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)


async def run_reconcile_worker(
    stop_event: asyncio.Event,
    *,
    worker_id: str,
    session_factory,
) -> None:
    """持久化任务消费者；关闭时先协作停止并 join 所有执行线程。"""
    settings = get_settings().filesync
    concurrency = max(1, min(8, settings.reconcile_max_concurrency))
    cleanup_checked = False
    active: set[asyncio.Task] = set()
    executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="filesync-scan")
    try:
        while not stop_event.is_set():
            completed = {task for task in active if task.done()}
            for task in completed:
                try:
                    task.result()
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    diag_log("filesync.reconcile_task", exc)
            active.difference_update(completed)
            try:
                while len(active) < concurrency and not stop_event.is_set():
                    async with session_factory() as db:
                        run = await claim_next_run(
                            db,
                            worker_id,
                            concurrency=concurrency,
                            budget_seconds=settings.reconcile_execution_budget_seconds,
                        )
                    if not cleanup_checked:
                        # 首次 claim 已将租约过期的旧任务标成明确失败；此后才能安全
                        # 清理它们留下的任务私有临时清单。
                        await _cleanup_stale_scan_artifacts(session_factory)
                        cleanup_checked = True
                    if run is None:
                        break
                    task = asyncio.create_task(
                        _run_claimed(session_factory, executor, run, worker_id, stop_event),
                        name=f"filesync-run-{str(run.id)[:8]}",
                    )
                    active.add(task)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                diag_log("filesync.reconcile_worker", exc)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=0.5)
            except TimeoutError:
                pass
    finally:
        # 不取消执行协程；它会设置线程停止标志，等线程和短事务退出后才释放任务。
        await asyncio.gather(*active, return_exceptions=True)
        executor.shutdown(wait=True, cancel_futures=False)
