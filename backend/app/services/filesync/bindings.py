"""本地目录绑定、dry-run、镜像模式和冲突处理。"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import File, FileSyncBinding, FileSyncConflict
from app.services.filesync.file_ops import (
    fingerprint as _fingerprint,
    root_fingerprint as _root_fingerprint,
)
from app.services.filesync.protocol import (
    FileSyncSource,
    FileSyncStatus,
    create_binding,
    build_idempotency_key,
    normalize_relative_path,
    record_change,
)
from app.services.filesync.snapshots import (
    read_snapshot,
    restore_snapshot,
    save_snapshot,
    snapshot_fingerprint,
)
from app.services.workspaces import workspace_shell_supported


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
        root_fingerprint = _root_fingerprint(root)
        scope_changed = (
            binding.root_path != root_path
            or binding.root_fingerprint != root_fingerprint
            or binding.mode != mode
            or binding.status != "active"
        )
        if scope_changed:
            binding.scope_revision = int(binding.scope_revision or 0) + 1
            binding.baseline_generation = None
            binding.baseline_dirty_revision = 0
        binding.root_path = root_path
        binding.mode = mode
        binding.root_fingerprint = root_fingerprint
        binding.protocol_version = 1
        binding.status = "active"
        await db.flush()
    return binding


async def _other_binding_roots(
    db: AsyncSession, user_id, binding: FileSyncBinding,
) -> list[Path]:
    """同一用户其他本地绑定覆盖的真实根目录，用于识别重叠绑定。"""
    others = (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_id,
        FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
        FileSyncBinding.status == "active",
        FileSyncBinding.id != binding.id,
    ))).all()
    roots: list[Path] = []
    for other in others:
        if other.workspace_id is not None:
            from app.services.workspaces import resolve_workspace_root

            root = await resolve_workspace_root(db, user_id, other.workspace_id)
        else:
            try:
                _, root = resolve_local_binding_root(user_id, other.root_path)
            except (OSError, ValueError):
                root = None
        if root is not None:
            roots.append(root)
    return roots


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


async def unbind_file_sync(db: AsyncSession, binding_id: int) -> FileSyncBinding | None:
    """停用同步绑定并取消其任务；不删除投影文件、冲突或审计记录。"""
    binding = await db.get(FileSyncBinding, binding_id)
    if binding is None:
        return None
    from app.services.filesync.job_lifecycle import cancel_binding_jobs

    await cancel_binding_jobs(db, binding.id)
    if binding.status != "inactive":
        binding.status = "inactive"
        binding.scope_revision = int(binding.scope_revision or 0) + 1
        binding.next_reconcile_at = None
    await db.flush()
    return binding


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


async def cleanup_stale_conflicts(
    db: AsyncSession,
    binding: FileSyncBinding,
    *,
    root: Path,
) -> int:
    """关闭两边对象都已消失的历史冲突。

    冲突本身是一次历史快照，文件后来被删除或移动时不会自动跟着消失。
    只有本地路径和当前 File 记录都不存在，才能确定它已经不再需要人工决策；
    只剩一边存在时仍保留为真实冲突，避免把删除与保留的选择误判成过期数据。
    """
    if not root.exists() or not root.is_dir():
        return 0

    settings = get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(binding.user_id)).resolve()
    try:
        root_prefix = root.expanduser().resolve().relative_to(user_root).as_posix()
    except ValueError:
        return 0
    storage_prefix = f"{binding.user_id}/"
    if root_prefix and root_prefix != ".":
        storage_prefix += root_prefix.rstrip("/") + "/"

    conflicts = (await db.scalars(select(FileSyncConflict).where(
        FileSyncConflict.binding_id == binding.id,
        FileSyncConflict.user_id == binding.user_id,
        FileSyncConflict.status == "pending",
    ))).all()
    cleaned = 0
    for conflict in conflicts:
        candidate = (root / conflict.relative_path).resolve(strict=False)
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            continue
        active_file = await db.scalar(select(File.id).where(
            File.user_id == binding.user_id,
            File.storage_key == storage_prefix + conflict.relative_path,
            File.deleted_at.is_(None),
        ))
        if candidate.is_file() or active_file is not None:
            continue
        now = now_utc()
        conflict.status = "resolved"
        conflict.resolution = "stale"
        conflict.resolved_at = now
        conflict.updated_at = now
        cleaned += 1
    return cleaned


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
        # 只解除冲突标记，不动盘上文件；必须同样落 resolved，
        # 否则冲突永远留在 pending 列表里（点「取消冲突」看起来毫无反应）。
        conflict.status = "resolved"
        conflict.resolution = "cancel"
        conflict.resolved_at = now_utc()
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
        from app.services.filesync.targeted import PathEventBatch, project_path_events

        relative_sibling = sibling.relative_to(root).as_posix()
        await project_path_events(
            db, user_id, binding, root,
            PathEventBatch(changed={relative_sibling}), allow_delete=False,
        )
    conflict.status = "resolved"
    conflict.resolution = resolution
    conflict.resolved_at = now_utc()
    conflict.updated_at = now_utc()
    await db.flush()
    return conflict
