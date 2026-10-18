"""管理端缺失文件预览与分批确认；不删除物理文件。"""
from hashlib import sha256
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, FileSyncBinding, FileSyncConflict
from app.services.filesync.admin import admin_resolve_conflict
from app.services.filesync.bindings import resolve_local_binding_root
from app.services.filesync.reconcile import _root_fingerprint
from app.services.workspaces import resolve_workspace_root


async def _scope(db: AsyncSession, binding_id: int) -> tuple[FileSyncBinding, Path, str]:
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.id == binding_id,
    ).execution_options(populate_existing=True))
    if (binding is None or binding.status != "active"
            or binding.source != "local_directory" or binding.mode == "mirror_out"):
        raise ValueError("绑定不是有效的本地同步目录")
    if binding.workspace_id is None:
        _, root = resolve_local_binding_root(binding.user_id, binding.root_path)
    else:
        root = await resolve_workspace_root(db, binding.user_id, binding.workspace_id)
    if root is None or not root.is_dir() or root.is_symlink():
        raise ValueError("绑定根目录不可用，不能确认缺失")
    if _root_fingerprint(root) != binding.root_fingerprint:
        raise ValueError("绑定根目录身份变化，请先重新核对")
    from app.services.filesync.bindings import _user_root

    relative = root.resolve().relative_to(_user_root(binding.user_id)).as_posix()
    prefix = f"{binding.user_id}/" if relative == "." else f"{binding.user_id}/{relative}/"
    return binding, root, prefix


def _root_identity(root: Path) -> str:
    stat = root.stat()
    return sha256(f"{root.resolve()}:{stat.st_dev}:{stat.st_ino}".encode()).hexdigest()


def _missing(root: Path, relative: str) -> bool:
    candidate = root / relative
    candidate.resolve(strict=False).relative_to(root.resolve())
    # stat 失败必须报错，不能把权限错误当成文件缺失。
    try:
        candidate.lstat()
    except FileNotFoundError:
        return True
    return False


async def preview_missing(db: AsyncSession, binding_id: int) -> dict:
    binding, root, prefix = await _scope(db, binding_id)
    rows = (await db.execute(select(FileSyncConflict, File).join(File, (
        (File.user_id == binding.user_id)
        & (File.storage_key == prefix + FileSyncConflict.relative_path)
        & File.deleted_at.is_(None)
    )).where(
        FileSyncConflict.binding_id == binding.id,
        FileSyncConflict.user_id == binding.user_id,
        FileSyncConflict.status == "pending",
        FileSyncConflict.local_fingerprint.is_(None),
    ).order_by(FileSyncConflict.id).limit(5001))).all()
    if len(rows) > 5000:
        raise ValueError("缺失冲突超过 5000 条，请先缩小范围")
    items = []
    for conflict, file in rows:
        if _missing(root, conflict.relative_path):
            items.append({"conflictId": conflict.id, "fileId": file.id,
                          "fileVersion": file.version,
                          "conflictRevision": conflict.updated_at.isoformat(),
                          "relativePath": conflict.relative_path})
    return {"bindingId": binding.id, "rootFingerprint": _root_identity(root), "items": items}


async def apply_missing(db: AsyncSession, binding_id: int, root_fingerprint: str, items: list[dict]) -> dict:
    binding, root, _ = await _scope(db, binding_id)
    if root_fingerprint != _root_identity(root):
        raise ValueError("预览已过期，请重新预览")
    results = []
    for item in items:
        try:
            # 每批及每项均重新验证根身份；锁住预览对象，防止版本检查后被并发修改。
            binding, root, prefix = await _scope(db, binding_id)
            if root_fingerprint != _root_identity(root):
                raise ValueError("预览根目录身份变化，请重新核对")
            conflict = await db.scalar(select(FileSyncConflict).where(
                FileSyncConflict.id == item["conflictId"],
                FileSyncConflict.binding_id == binding_id,
                FileSyncConflict.user_id == binding.user_id,
            ).with_for_update())
            file = await db.scalar(select(File).where(
                File.id == item["fileId"], File.user_id == binding.user_id,
            ).with_for_update())
            if (conflict is None or file is None or conflict.status != "pending"
                    or conflict.local_fingerprint is not None
                    or conflict.updated_at.isoformat() != item["conflictRevision"]
                    or file.deleted_at is not None or file.version != item["fileVersion"]
                    or file.storage_key != prefix + conflict.relative_path):
                raise ValueError("预览对象已变化，请重新核对")
            if not _missing(root, conflict.relative_path):
                raise ValueError("本地路径已恢复，已跳过")
            await admin_resolve_conflict(db, conflict.id, "confirm_delete")
            results.append({"id": item["conflictId"], "status": "completed"})
        except (LookupError, ValueError, OSError) as exc:
            await db.rollback()
            from app.core.redaction import redact

            results.append({"id": item["conflictId"], "status": "skipped", "reason": redact(str(exc))})
    return {"results": results}
