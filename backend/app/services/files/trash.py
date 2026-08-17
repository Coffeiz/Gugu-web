from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.ownership import get_owned
from app.models import File, Folder, Project
from app.services.storage.folders import folder_dir_key
from app.services.storage.trash import restore_file_storage


class RestoreParentTrashError(Exception):
    """文件所属文件夹仍在回收站，不能单独恢复。"""


def top_level_deleted_folders_stmt(user_id=None):
    """构造回收站顶层文件夹查询。

    用户回收站传入 ``user_id`` 做归属隔离；过期清理任务不传用户，执行全局清理。
    """
    parent_folder = aliased(Folder)
    stmt = (
        select(Folder)
        .outerjoin(parent_folder, Folder.parent_id == parent_folder.id)
        .where(
            Folder.deleted_at.isnot(None),
            (Folder.parent_id.is_(None)) | (parent_folder.deleted_at.is_(None)),
        )
    )
    if user_id is not None:
        stmt = stmt.where(Folder.user_id == user_id)
    return stmt.order_by(Folder.deleted_at.desc())


async def list_top_level_deleted_folders(db: AsyncSession, user_id):
    """列出当前用户回收站中的全部顶层文件夹，供 API 编排与清空回收站复用。"""
    return (await db.execute(top_level_deleted_folders_stmt(user_id))).scalars().all()


async def list_top_level_deleted_folders_with_counts(db: AsyncSession, user_id):
    """列出顶层回收站文件夹及其直属已删文件数，避免 API 层直接拼 ORM 查询。"""
    folders = await list_top_level_deleted_folders(db, user_id)
    if not folders:
        return [], {}
    counts = await db.execute(
        select(File.folder_id, func.count().label("cnt")).where(
            File.user_id == user_id,
            File.folder_id.in_([folder.id for folder in folders]),
            File.deleted_at.isnot(None),
        ).group_by(File.folder_id)
    )
    return folders, {row.folder_id: row.cnt for row in counts}


async def get_top_level_deleted_folder(db: AsyncSession, user_id, folder_id: int):
    """读取当前用户可见的顶层回收站文件夹。"""
    return (await db.execute(
        top_level_deleted_folders_stmt(user_id).where(Folder.id == folder_id)
    )).scalar_one_or_none()


async def list_deleted_files(db: AsyncSession, user_id, limit: int):
    """列出当前用户回收站中的独立文件。"""
    return (await db.execute(
        select(File).outerjoin(Folder, File.folder_id == Folder.id).where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
            or_(File.folder_id.is_(None), Folder.deleted_at.is_(None)),
        ).order_by(File.deleted_at.desc()).limit(limit)
    )).scalars().all()


async def list_deleted_folders(db: AsyncSession, user_id, limit: int):
    """列出当前用户回收站中的顶层文件夹。"""
    return (await db.execute(
        top_level_deleted_folders_stmt(user_id).limit(limit)
    )).scalars().all()


async def list_trash_file_rows(db: AsyncSession, user_id):
    """查询回收站独立文件及响应所需的关联名称。"""
    return (await db.execute(
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
            or_(File.folder_id.is_(None), Folder.deleted_at.is_(None)),
        ).order_by(File.deleted_at.desc())
    )).all()


async def list_trash_folder_contents_rows(db: AsyncSession, user_id, folder_id: int):
    """查询顶层回收站文件夹的直属文件夹、文件和浅层计数。"""
    folder = await get_top_level_deleted_folder(db, user_id, folder_id)
    if not folder:
        return None
    child_folders = (await db.execute(
        select(Folder).where(
            Folder.user_id == user_id,
            Folder.parent_id == folder.id,
            Folder.deleted_at.isnot(None),
        ).order_by(Folder.deleted_at.desc())
    )).scalars().all()
    direct_files = (await db.execute(
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.user_id == user_id,
            File.folder_id == folder.id,
            File.deleted_at.isnot(None),
        ).order_by(File.deleted_at.desc())
    )).all()
    counts = await db.execute(
        select(File.folder_id, func.count().label("cnt")).where(
            File.user_id == user_id,
            File.folder_id.in_([item.id for item in child_folders]),
            File.deleted_at.isnot(None),
        ).group_by(File.folder_id)
    ) if child_folders else None
    count_map = {row.folder_id: row.cnt for row in counts} if counts else {}
    return folder, child_folders, direct_files, count_map


async def count_deleted_files(db: AsyncSession, user_id) -> int:
    """统计当前用户回收站文件数量，不修改事务。"""
    return (await db.execute(
        select(func.count(File.id)).where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
        )
    )).scalar_one()


async def get_deleted_file(db: AsyncSession, user_id, file_id):
    """读取当前用户自己的回收站文件，供确认文案使用。"""
    file = await get_owned(db, File, file_id, user_id)
    return file if file and file.deleted_at is not None else None


async def permanently_delete_all_files(db: AsyncSession, storage, user_id) -> list[int]:
    """永久删除当前用户回收站中的独立文件，返回已删除文件 ID。"""
    files = (await db.execute(
        select(File).where(File.user_id == user_id, File.deleted_at.isnot(None))
    )).scalars().all()
    file_ids = [file.id for file in files]
    for file in files:
        try:
            await storage.delete(file.storage_key)
        except Exception:
            pass
        await db.delete(file)
    return file_ids


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


async def empty_trash(
    db: AsyncSession,
    storage,
    user_id: int,
    root_folders: list[Folder],
) -> list[int]:
    """清理当前用户回收站内容，返回待清理缩略图的文件 ID。"""
    files = (await db.execute(
        select(File).where(File.user_id == user_id, File.deleted_at.isnot(None))
    )).scalars().all()
    file_ids = [file.id for file in files]
    for file in files:
        try:
            await storage.delete(file.storage_key)
        except Exception:
            pass
        await db.delete(file)

    for root in root_folders:
        dir_key = await folder_dir_key(db, root.user_id, root)
        await db.delete(root)
        if dir_key:
            try:
                await storage.remove_folder(dir_key)
            except Exception:
                pass
    return file_ids
