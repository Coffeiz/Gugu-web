from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.ownership import get_owned
from app.models import File, Folder, Project
from app.services.storage.folders import folder_dir_key
from app.services.storage.trash import restore_file_storage
from app.services.files.pagination import apply_keyset, decode_cursor, encode_cursor


class RestoreParentTrashError(Exception):
    """文件所属文件夹仍在回收站，不能单独恢复。"""


def top_level_deleted_folders_stmt(user_id=None, deleted_before=None):
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
    if deleted_before is not None:
        stmt = stmt.where(Folder.deleted_at <= deleted_before)
    return stmt.order_by(Folder.deleted_at.desc())


async def list_top_level_deleted_folders(db: AsyncSession, user_id):
    """列出当前用户回收站中的全部顶层文件夹，供 API 编排与清空回收站复用。"""
    return (await db.execute(top_level_deleted_folders_stmt(user_id))).scalars().all()


async def get_top_level_deleted_folder(db: AsyncSession, user_id, folder_id: int):
    """读取当前用户可见的顶层回收站文件夹。"""
    return (await db.execute(
        top_level_deleted_folders_stmt(user_id).where(Folder.id == folder_id)
    )).scalar_one_or_none()


async def list_deleted_files(db: AsyncSession, user_id, limit: int, deleted_before=None):
    """列出当前用户回收站中的独立文件。"""
    stmt = select(File).outerjoin(Folder, File.folder_id == Folder.id).where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
            or_(File.folder_id.is_(None), Folder.deleted_at.is_(None)),
        )
    if deleted_before is not None:
        stmt = stmt.where(File.deleted_at <= deleted_before)
    return (await db.execute(stmt.order_by(File.deleted_at.desc()).limit(limit))).scalars().all()


async def list_deleted_folders(db: AsyncSession, user_id, limit: int, deleted_before=None):
    """列出当前用户回收站中的顶层文件夹。"""
    return (await db.execute(
        top_level_deleted_folders_stmt(user_id, deleted_before).limit(limit)
    )).scalars().all()


async def list_trash_file_page_rows(db: AsyncSession, user_id, *, limit: int, cursor: str | None):
    scope = {"resource": "trash_files", "sort": "deletedAt_desc_id_desc"}
    stmt = (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
            or_(File.folder_id.is_(None), Folder.deleted_at.is_(None)),
        )
    )
    boundary = decode_cursor(cursor, user_id=user_id, scope=scope)
    if boundary:
        stmt = apply_keyset(
            stmt, model=File, sort_column=File.deleted_at,
            sort_value=datetime.fromisoformat(str(boundary[0])),
            entity_id=boundary[1], direction="desc",
        )
    rows = (await db.execute(
        stmt.order_by(File.deleted_at.desc(), File.id.desc()).limit(limit + 1)
    )).all()
    has_more = len(rows) > limit
    items = rows[:limit]
    next_cursor = encode_cursor(
        user_id=user_id, scope=scope,
        sort_value=items[-1][0].deleted_at.isoformat(), entity_id=items[-1][0].id,
    ) if has_more and items else None
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


async def count_trash_root_items(db: AsyncSession, user_id) -> int:
    """统计回收站根列表可见的独立文件和顶层文件夹。"""
    file_count = await db.scalar(
        select(func.count(File.id))
        .select_from(File)
        .outerjoin(Folder, File.folder_id == Folder.id)
        .where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
            or_(File.folder_id.is_(None), Folder.deleted_at.is_(None)),
        )
    )
    folder_count = await db.scalar(
        top_level_deleted_folders_stmt(user_id)
        .with_only_columns(func.count(Folder.id))
        .order_by(None)
    )
    return int(file_count or 0) + int(folder_count or 0)


async def list_trash_folder_page_rows(db: AsyncSession, user_id, *, limit: int, cursor: str | None):
    scope = {"resource": "trash_folders", "sort": "deletedAt_desc_id_desc"}
    stmt = top_level_deleted_folders_stmt(user_id)
    boundary = decode_cursor(cursor, user_id=user_id, scope=scope)
    if boundary:
        stmt = apply_keyset(
            stmt, model=Folder, sort_column=Folder.deleted_at,
            sort_value=datetime.fromisoformat(str(boundary[0])),
            entity_id=boundary[1], direction="desc",
        )
    folders = (await db.execute(stmt.order_by(None).order_by(
        Folder.deleted_at.desc(), Folder.id.desc(),
    ).limit(limit + 1))).scalars().all()
    has_more = len(folders) > limit
    items = folders[:limit]
    counts = await db.execute(
        select(File.folder_id, func.count().label("cnt")).where(
            File.user_id == user_id,
            File.folder_id.in_([folder.id for folder in items]),
            File.deleted_at.isnot(None),
        ).group_by(File.folder_id)
    ) if items else None
    count_map = {row.folder_id: row.cnt for row in counts} if counts else {}
    next_cursor = encode_cursor(
        user_id=user_id, scope=scope,
        sort_value=items[-1].deleted_at.isoformat(), entity_id=items[-1].id,
    ) if has_more and items else None
    return {"items": [(folder, count_map.get(folder.id, 0)) for folder in items],
            "next_cursor": next_cursor, "has_more": has_more}


async def list_trash_folder_contents_page_rows(
    db: AsyncSession,
    user_id,
    folder_id: int,
    *,
    limit: int,
    folder_cursor: str | None,
    file_cursor: str | None,
):
    """分页读取某个回收站根文件夹的直属内容。"""
    folder = await get_top_level_deleted_folder(db, user_id, folder_id)
    if not folder:
        return None

    folder_scope = {"resource": "trash_folder_children", "folder_id": folder_id}
    folder_stmt = select(Folder).where(
        Folder.user_id == user_id,
        Folder.parent_id == folder.id,
        Folder.deleted_at.isnot(None),
    )
    folder_boundary = decode_cursor(folder_cursor, user_id=user_id, scope=folder_scope)
    if folder_boundary:
        folder_stmt = apply_keyset(
            folder_stmt, model=Folder, sort_column=Folder.deleted_at,
            sort_value=datetime.fromisoformat(str(folder_boundary[0])),
            entity_id=folder_boundary[1], direction="desc",
        )
    child_folders = (await db.execute(folder_stmt.order_by(
        Folder.deleted_at.desc(), Folder.id.desc(),
    ).limit(limit + 1))).scalars().all()
    more_folders = len(child_folders) > limit
    child_folders = child_folders[:limit]

    file_scope = {"resource": "trash_folder_files", "folder_id": folder_id}
    file_stmt = (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.user_id == user_id,
            File.folder_id == folder.id,
            File.deleted_at.isnot(None),
        )
    )
    file_boundary = decode_cursor(file_cursor, user_id=user_id, scope=file_scope)
    if file_boundary:
        file_stmt = apply_keyset(
            file_stmt, model=File, sort_column=File.deleted_at,
            sort_value=datetime.fromisoformat(str(file_boundary[0])),
            entity_id=file_boundary[1], direction="desc",
        )
    direct_files = (await db.execute(file_stmt.order_by(
        File.deleted_at.desc(), File.id.desc(),
    ).limit(limit + 1))).all()
    more_files = len(direct_files) > limit
    direct_files = direct_files[:limit]

    counts = await db.execute(
        select(File.folder_id, func.count().label("cnt")).where(
            File.user_id == user_id,
            File.folder_id.in_([item.id for item in child_folders]),
            File.deleted_at.isnot(None),
        ).group_by(File.folder_id)
    ) if child_folders else None
    count_map = {row.folder_id: row.cnt for row in counts} if counts else {}
    next_folder_cursor = encode_cursor(
        user_id=user_id, scope=folder_scope,
        sort_value=child_folders[-1].deleted_at.isoformat(), entity_id=child_folders[-1].id,
    ) if more_folders and child_folders else None
    next_file_cursor = encode_cursor(
        user_id=user_id, scope=file_scope,
        sort_value=direct_files[-1][0].deleted_at.isoformat(), entity_id=direct_files[-1][0].id,
    ) if more_files and direct_files else None
    return {
        "folder": folder,
        "folders": {"items": [(item, count_map.get(item.id, 0)) for item in child_folders],
                    "next_cursor": next_folder_cursor, "has_more": more_folders},
        "files": {"items": direct_files, "next_cursor": next_file_cursor, "has_more": more_files},
    }


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
