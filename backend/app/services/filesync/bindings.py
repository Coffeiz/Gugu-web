"""本地目录绑定、dry-run、镜像模式和冲突处理。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncConflict, FileSyncJournal
from app.services.filesync.protocol import (
    FileSyncMode,
    FileSyncSource,
    FileSyncStatus,
    create_binding,
    build_idempotency_key,
    is_file_sync_enabled,
    normalize_relative_path,
    record_change,
)
from app.services.filesync.reconcile import (
    SyncSummary,
    _fingerprint,
    _root_fingerprint,
    reconcile_local_directory,
)
from app.services.filesync.snapshots import (
    read_snapshot,
    restore_snapshot,
    save_snapshot,
    snapshot_fingerprint,
)
from app.services.workspaces import workspace_shell_supported
from app.services.storage import get_storage


@dataclass(frozen=True)
class BindingSyncResult:
    binding_id: int | None
    mode: str
    root_path: str
    dry_run: bool
    summary: SyncSummary
    conflict_ids: tuple[int, ...] = ()


def _user_root(user_id) -> Path:
    return (Path(get_settings().storage.local_path).expanduser().resolve() / str(user_id)).resolve()


def _normalize_root_path(value: str | None) -> str:
    value = str(value or ".").strip()
    if value in {".", "./", ""}:
        return "."
    return normalize_relative_path(value)


def resolve_local_binding_root(user_id, root_path: str | None) -> tuple[str, Path]:
    """只允许绑定当前用户 local storage 根下的相对目录。"""
    relative = _normalize_root_path(root_path)
    user_root = _user_root(user_id)
    requested = user_root if relative == "." else user_root / relative
    if requested.is_symlink():
        raise ValueError("同步目录不能是软链接")
    root = requested.resolve()
    try:
        root.relative_to(user_root)
    except ValueError as exc:
        raise ValueError("同步目录必须位于当前用户存储根内") from exc
    if not root.exists() or not root.is_dir() or root.is_symlink():
        raise ValueError("同步目录不存在或不是安全目录")
    return relative, root


async def _get_or_create_binding(
    db: AsyncSession,
    user_id,
    *,
    root_path: str,
    root: Path,
    mode: str,
) -> FileSyncBinding:
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_id,
        FileSyncBinding.workspace_id.is_(None),
        FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
    ))
    if binding is None:
        binding = await create_binding(
            db, user_id=user_id, source=FileSyncSource.LOCAL_DIRECTORY,
            root_fingerprint=_root_fingerprint(root), mode=mode, root_path=root_path,
        )
    else:
        binding.root_path = root_path
        binding.mode = mode
        binding.root_fingerprint = _root_fingerprint(root)
        binding.protocol_version = 1
        binding.status = "active"
        await db.flush()
    return binding


async def _pending_conflicts(
    db: AsyncSession,
    user_id,
    binding: FileSyncBinding,
    root: Path,
) -> tuple[int, ...]:
    """识别 DB 侧和物理侧都在同一基线后变化的文件。"""
    if binding.mode != FileSyncMode.BIDIRECTIONAL:
        return ()
    user_root = _user_root(user_id)
    prefix = root.relative_to(user_root).as_posix().rstrip("/")
    storage_prefix = f"{user_id}/{prefix}/" if prefix != "." else f"{user_id}/"
    rows = (await db.scalars(select(File).where(
        File.user_id == user_id, File.deleted_at.is_(None),
        File.storage_key.like(f"{storage_prefix}%"),
    ))).all()
    journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.status == FileSyncStatus.SYNCED,
    ).order_by(FileSyncJournal.id.desc()))).all()
    latest = {}
    for journal in journals:
        latest.setdefault(journal.relative_path, journal)
    conflict_ids: list[int] = []
    for row in rows:
        relative = row.storage_key.removeprefix(storage_prefix)
        journal = latest.get(relative)
        path = root / relative
        if journal is None or not path.is_file() or path.is_symlink():
            continue
        try:
            local_fingerprint = _fingerprint(path)
        except OSError:
            continue
        if row.updated_at <= journal.updated_at or local_fingerprint == journal.observed_fingerprint:
            continue
        existing = await db.scalar(select(FileSyncConflict).where(
            FileSyncConflict.binding_id == binding.id,
            FileSyncConflict.relative_path == relative,
            FileSyncConflict.status == "pending",
        ))
        if existing is None:
            existing = FileSyncConflict(
                binding_id=binding.id, user_id=user_id, relative_path=relative,
                baseline_fingerprint=journal.observed_fingerprint,
                local_fingerprint=local_fingerprint,
                remote_fingerprint=(
                    snapshot_fingerprint(user_id, binding.id, relative)
                    or journal.observed_fingerprint
                ),
                source=FileSyncSource.LOCAL_DIRECTORY,
                status="pending",
            )
            db.add(existing)
            await db.flush()
        conflict_ids.append(existing.id)
    return tuple(conflict_ids)


async def _mirror_out_summary(root: Path, user_id, db: AsyncSession) -> SyncSummary:
    """把 DB 事实源中的对象复制到绑定目录，不反向创建 DB 行。"""
    scanned = 0
    rejected = 0
    copied = 0
    entity_ids: list[int] = []
    user_root = _user_root(user_id)
    rows = (await db.scalars(select(File).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).all()
    storage_root = user_root.parent
    storage = get_storage()
    for row in rows:
        source = (storage_root / row.storage_key).resolve()
        try:
            relative = source.relative_to(user_root)
            destination = (root / relative).resolve()
            destination.relative_to(root)
        except ValueError:
            rejected += 1
            continue
        if source == destination and destination.is_file():
            scanned += 1
            continue
        if not await storage.exists(row.storage_key):
            rejected += 1
            continue
        try:
            destination_key = destination.relative_to(storage_root).as_posix()
            await storage.copy(row.storage_key, destination_key)
        except (OSError, ValueError):
            rejected += 1
            continue
        scanned += 1
        copied += 1
        entity_ids.append(row.id)
    return SyncSummary(scanned=scanned, updated=copied, rejected=rejected, entity_ids=tuple(entity_ids))


async def _sync_binding(
    db: AsyncSession,
    user_id,
    *,
    root_path: str,
    root: Path,
    mode: str,
    allow_delete: bool,
) -> BindingSyncResult:
    binding = await _get_or_create_binding(
        db, user_id, root_path=root_path, root=root, mode=mode,
    )
    conflict_ids = await _pending_conflicts(db, user_id, binding, root)
    blocked = set()
    if conflict_ids:
        blocked = set((await db.scalars(select(FileSyncConflict.relative_path).where(
            FileSyncConflict.id.in_(conflict_ids),
        ))).all())
    if mode == FileSyncMode.MIRROR_OUT:
        summary = await _mirror_out_summary(root, user_id, db)
    else:
        summary = await reconcile_local_directory(
            db, user_id, root=root, source=FileSyncSource.LOCAL_DIRECTORY,
            allow_delete=allow_delete, blocked_paths=blocked,
        )
    binding.last_reconciled_at = now_utc()
    await db.flush()
    return BindingSyncResult(
        binding_id=binding.id, mode=mode, root_path=root_path,
        dry_run=False, summary=SyncSummary(
            scanned=summary.scanned, created=summary.created, updated=summary.updated,
            moved=summary.moved, deleted=summary.deleted, rejected=summary.rejected,
            conflicts=len(conflict_ids), journal_ids=summary.journal_ids,
            entity_ids=summary.entity_ids,
        ), conflict_ids=conflict_ids,
    )


async def dry_run_local_binding(
    db: AsyncSession,
    user_id,
    *,
    root_path: str = ".",
    mode: str = FileSyncMode.BIDIRECTIONAL,
) -> BindingSyncResult:
    if not is_file_sync_enabled() or not workspace_shell_supported():
        return BindingSyncResult(None, mode, _normalize_root_path(root_path), True, SyncSummary(rejected=1))
    if mode not in {item.value for item in FileSyncMode}:
        raise ValueError("同步模式无效")
    relative, root = resolve_local_binding_root(user_id, root_path)
    nested = await db.begin_nested()
    try:
        result = await _sync_binding(
            db, user_id, root_path=relative, root=root, mode=mode, allow_delete=False,
        )
        return BindingSyncResult(
            result.binding_id, result.mode, result.root_path, True,
            result.summary, result.conflict_ids,
        )
    finally:
        await nested.rollback()


async def sync_local_binding(
    db: AsyncSession,
    user_id,
    *,
    root_path: str = ".",
    mode: str = FileSyncMode.BIDIRECTIONAL,
    allow_delete: bool = False,
) -> BindingSyncResult:
    if not is_file_sync_enabled() or not workspace_shell_supported():
        return BindingSyncResult(None, mode, _normalize_root_path(root_path), False, SyncSummary(rejected=1))
    if mode not in {item.value for item in FileSyncMode}:
        raise ValueError("同步模式无效")
    relative, root = resolve_local_binding_root(user_id, root_path)
    return await _sync_binding(
        db, user_id, root_path=relative, root=root, mode=mode, allow_delete=allow_delete,
    )


async def get_user_binding(db: AsyncSession, user_id, binding_id: int) -> FileSyncBinding | None:
    if not workspace_shell_supported():
        return None
    return await get_owned(db, FileSyncBinding, binding_id, user_id)


async def list_user_bindings(db: AsyncSession, user_id) -> list[FileSyncBinding]:
    if not workspace_shell_supported():
        return []
    return (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_id,
    ).order_by(FileSyncBinding.updated_at.desc()))).all()


async def list_user_conflicts(db: AsyncSession, user_id, binding_id: int | None = None):
    if not workspace_shell_supported():
        return []
    query = select(FileSyncConflict).where(
        FileSyncConflict.user_id == user_id,
        FileSyncConflict.status == "pending",
    ).order_by(FileSyncConflict.created_at.desc())
    if binding_id is not None:
        query = query.where(FileSyncConflict.binding_id == binding_id)
    return (await db.scalars(query)).all()


async def resolve_sync_conflict(
    db: AsyncSession,
    user_id,
    conflict_id: int,
    resolution: str,
) -> FileSyncConflict:
    if not workspace_shell_supported():
        raise LookupError("OSS 存储模式不支持文件同步")
    if resolution not in {"keep_local", "keep_remote", "keep_both", "cancel"}:
        raise ValueError("冲突处理方式无效")
    conflict = await get_owned(db, FileSyncConflict, conflict_id, user_id)
    if conflict is None or conflict.status != "pending":
        raise LookupError("同步冲突不存在")
    binding = await get_owned(db, FileSyncBinding, conflict.binding_id, user_id)
    if binding is None:
        raise LookupError("同步绑定不存在")
    _, root = resolve_local_binding_root(user_id, binding.root_path)
    candidate = root / conflict.relative_path
    observed = _fingerprint(candidate) if candidate.is_file() and not candidate.is_symlink() else None
    if resolution == "cancel":
        conflict.resolution = "cancel"
        conflict.updated_at = now_utc()
        await db.flush()
        return conflict
    if resolution == "keep_remote":
        if not restore_snapshot(user_id, binding.id, conflict.relative_path, candidate):
            raise ValueError("冲突缺少可恢复的远端快照")
        observed = _fingerprint(candidate)
    elif resolution == "keep_both":
        remote = read_snapshot(user_id, binding.id, conflict.relative_path)
        if remote is None:
            raise ValueError("冲突缺少可保留的远端快照")
        sibling = candidate.with_name(f"{candidate.stem} (remote){candidate.suffix}")
        index = 2
        while sibling.exists():
            sibling = candidate.with_name(f"{candidate.stem} (remote {index}){candidate.suffix}")
            index += 1
        sibling.write_bytes(remote)
    if observed is not None:
        await record_change(
            db, binding=binding, user_id=user_id, source=FileSyncSource.LOCAL_DIRECTORY,
            operation="update", relative_path=conflict.relative_path,
            idempotency_key=build_idempotency_key(
                source=FileSyncSource.LOCAL_DIRECTORY, operation="update",
                relative_path=conflict.relative_path, fingerprint=observed,
            ), observed_fingerprint=observed, status=FileSyncStatus.SYNCED,
        )
        save_snapshot(user_id, binding.id, conflict.relative_path, candidate)
    if resolution == "keep_both":
        await reconcile_local_directory(
            db, user_id, root=root, source=FileSyncSource.LOCAL_DIRECTORY,
            allow_delete=False,
        )
    conflict.status = "resolved"
    conflict.resolution = resolution
    conflict.resolved_at = now_utc()
    conflict.updated_at = now_utc()
    await db.flush()
    return conflict
