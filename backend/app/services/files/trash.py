from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import File, Folder
from app.services.storage.folders import folder_dir_key
from app.services.storage.trash import restore_file_storage


class RestoreParentTrashError(Exception):
    """文件所属文件夹仍在回收站，不能单独恢复。"""


async def permanently_delete_file(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
) -> int | None:
    """永久删除一个已在回收站中的文件，返回文件 ID。"""
    file = await get_owned(db, File, file_id, user_id)
    if not file or file.deleted_at is None:
        return None

    try:
        await storage.delete(file.storage_key)
    except Exception:
        # 存储对象缺失时仍删除数据库墓碑，保持原有清理语义。
        pass
    await db.delete(file)
    return file.id


async def restore_file_by_id(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
) -> bool:
    """恢复单个文件；父文件夹仍在回收站时抛出领域冲突。"""
    file = await get_owned(db, File, file_id, user_id)
    if not file or file.deleted_at is None:
        return False

    if file.folder_id is not None:
        folder = await get_owned(db, Folder, file.folder_id, user_id)
        if not folder or folder.deleted_at is not None:
            raise RestoreParentTrashError

    await restore_file_storage(file, storage, db)
    file.deleted_at = None
    return True


async def restore_files_by_ids(
    db: AsyncSession,
    storage,
    user_id: int,
    file_ids: list[int],
) -> list[int]:
    """批量恢复文件；先完成全部父目录校验，再执行物理恢复。"""
    if not file_ids:
        return []
    files = (await db.execute(
        select(File).where(
            File.id.in_(file_ids),
            File.user_id == user_id,
            File.deleted_at.isnot(None),
        )
    )).scalars().all()
    for file in files:
        if file.folder_id is None:
            continue
        folder = await get_owned(db, Folder, file.folder_id, user_id)
        if not folder or folder.deleted_at is not None:
            raise RestoreParentTrashError
    for file in files:
        await restore_file_storage(file, storage, db)
        file.deleted_at = None
    return [file.id for file in files]


async def permanently_delete_folder(
    db: AsyncSession,
    storage,
    folder: Folder,
) -> list[int]:
    """永久删除已确认的顶层回收站文件夹及其已删子树。"""
    folder_ids = [folder.id]
    frontier = [folder.id]
    while frontier:
        children = (await db.execute(
            select(Folder.id).where(
                Folder.user_id == folder.user_id,
                Folder.parent_id.in_(frontier),
                Folder.deleted_at.isnot(None),
            )
        )).scalars().all()
        folder_ids.extend(children)
        frontier = children

    files = (await db.execute(
        select(File).where(
            File.user_id == folder.user_id,
            File.folder_id.in_(folder_ids),
            File.deleted_at.isnot(None),
        )
    )).scalars().all()
    for file in files:
        try:
            await storage.delete(file.storage_key)
        except Exception:
            pass
        await db.delete(file)

    dir_key = await folder_dir_key(db, folder.user_id, folder)
    await db.delete(folder)
    if dir_key:
        try:
            await storage.remove_folder(dir_key)
        except Exception:
            pass
    return [file.id for file in files]
