import asyncio
from typing import Optional

from sqlalchemy import Select, func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Folder, Project
from app.core.ownership import get_owned
from app.services.storage import LocalStorageBackend
from app.search.query import keyword_condition, normalize_queries

_VERSION_RETRY_BACKOFF = (0.05, 0.15)


def _is_deadlock_error(exc: DBAPIError) -> bool:
    """仅识别 PostgreSQL/asyncpg 的死锁，避免把普通数据库错误当成可重试。"""
    return type(getattr(exc, "orig", None)).__name__ == "DeadlockDetectedError"


def file_listing_query(
    user_id: int,
    space: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_id: Optional[int] = None,
    mind_map_id: Optional[int] = None,
    ext: Optional[str] = None,
    query: Optional[str] = None,
) -> Select:
    stmt = (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(File.user_id == user_id, File.deleted_at.is_(None))
        .order_by(File.created_at.desc())
    )
    if space:
        stmt = stmt.where(File.space == space)
    if project_id is not None:
        stmt = stmt.where(File.project_id == project_id)
    if folder_id is not None:
        stmt = stmt.where(File.folder_id == folder_id)
    elif project_id is not None and space == "project":
        stmt = stmt.where(File.folder_id.is_(None))
    elif project_id is None and space == "personal":
        stmt = stmt.where(File.folder_id.is_(None))
    if mind_map_id is not None:
        stmt = stmt.where(File.mind_map_id == mind_map_id)
    if ext:
        stmt = stmt.where(File.ext == ext.upper())
    if query:
        stmt = stmt.where(File.display_name.ilike(f"%{query}%"))
    return stmt


def all_files_query(user_id: int) -> Select:
    return (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(File.user_id == user_id, File.deleted_at.is_(None))
        .order_by(File.created_at.desc())
    )


def storage_usage_query(user_id: int) -> Select:
    return select(func.sum(File.size_bytes)).where(File.user_id == user_id)


async def list_file_rows(
    db: AsyncSession,
    user_id: int,
    *,
    space: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_id: Optional[int] = None,
    mind_map_id: Optional[int] = None,
    ext: Optional[str] = None,
    query: Optional[str] = None,
):
    """查询当前目录文件行；响应模型组装由 API 边界负责。"""
    result = await db.execute(file_listing_query(
        user_id,
        space=space,
        project_id=project_id,
        folder_id=folder_id,
        mind_map_id=mind_map_id,
        ext=ext,
        query=query,
    ))
    return result.all()


async def list_all_file_rows(db: AsyncSession, user_id: int):
    """查询当前用户全部存活文件行。"""
    result = await db.execute(all_files_query(user_id))
    return result.all()


async def list_existing_file_rows(db: AsyncSession, storage, user_id: int):
    """列出全部文件，并清理本地存储中已经丢失实体文件的数据库记录。"""
    rows = await list_all_file_rows(db, user_id)
    if not isinstance(storage, LocalStorageBackend):
        return rows, False

    valid_rows = []
    for row in rows:
        file = row[0]
        if (storage.root / file.storage_key).exists():
            valid_rows.append(row)
        else:
            await db.delete(file)
    return valid_rows, len(valid_rows) < len(rows)


async def get_storage_usage(db: AsyncSession, user_id: int) -> int:
    """返回当前用户已使用的存储字节数。"""
    result = await db.execute(storage_usage_query(user_id))
    return result.scalar() or 0


async def get_file_version_snapshot(db: AsyncSession, user_id: int):
    """查询文件表状态摘要所需的聚合值。"""
    stmt = select(
        func.count(File.id),
        func.max(File.updated_at),
        func.max(File.deleted_at),
    ).where(File.user_id == user_id)
    for attempt in range(len(_VERSION_RETRY_BACKOFF) + 1):
        try:
            return (await db.execute(stmt)).one()
        except DBAPIError as exc:
            if not _is_deadlock_error(exc) or attempt >= len(_VERSION_RETRY_BACKOFF):
                raise
            await db.rollback()
            await asyncio.sleep(_VERSION_RETRY_BACKOFF[attempt])


async def get_file_tree_rows(db: AsyncSession, user_id: int):
    """查询文件库树所需的项目文件计数、项目行和个人文件计数。"""
    project_file_rows = await db.execute(
        select(File.project_id, func.count().label("cnt"))
        .where(
            File.user_id == user_id,
            File.space == "project",
            File.project_id.isnot(None),
            File.deleted_at.is_(None),
        )
        .group_by(File.project_id)
    )
    project_rows = await db.execute(
        select(Project)
        .where(Project.user_id == user_id)
        .order_by(Project.created_at.desc())
    )
    personal_count = await db.execute(
        select(func.count()).where(
            File.user_id == user_id,
            File.space == "personal",
            File.deleted_at.is_(None),
        )
    )
    return project_file_rows.all(), project_rows.scalars().all(), personal_count.scalar_one()


async def folder_download_rows(db: AsyncSession, user_id: int, folder_id: int):
    """读取当前用户文件夹下载所需的文件行及其归档路径。"""
    from app.core.ownership import get_owned

    folder = await get_owned(db, Folder, folder_id, user_id)
    if not folder or folder.deleted_at is not None:
        return None

    rows = []
    queue = [(folder.id, folder.name)]
    while queue:
        current_id, path_prefix = queue.pop(0)
        files = (await db.execute(
            select(File).where(
                File.folder_id == current_id,
                File.user_id == user_id,
                File.deleted_at.is_(None),
            )
        )).scalars().all()
        rows.extend((file, f"{path_prefix}/{file.display_name}.{file.ext.lower()}") for file in files)

        subfolders = (await db.execute(
            select(Folder).where(
                Folder.parent_id == current_id,
                Folder.user_id == user_id,
                Folder.deleted_at.is_(None),
            )
        )).scalars().all()
        queue.extend((sub.id, f"{path_prefix}/{sub.name}") for sub in subfolders)
    return folder, rows


async def search_user_files(
    db: AsyncSession,
    user_id,
    *,
    space=None,
    project_id=None,
    folder_id=None,
    ext=None,
    queries=None,
    mode=None,
    limit=100,
):
    """查询 Agent 文件工具使用的当前用户存活文件。"""
    stmt = select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
    if space:
        stmt = stmt.where(File.space == space)
    if project_id is not None:
        stmt = stmt.where(File.project_id == project_id)
    if folder_id is not None:
        stmt = stmt.where(File.folder_id == folder_id)
    if ext:
        stmt = stmt.where(File.ext == ext.lower().lstrip("."))
    normalized = normalize_queries(queries=queries)
    if normalized:
        stmt = stmt.where(keyword_condition([File.display_name], normalized, mode))
    return (await db.execute(
        stmt.order_by(File.updated_at.desc()).limit(limit)
    )).scalars().all()


async def get_user_file(db: AsyncSession, user_id, file_id):
    """读取当前用户的存活文件。"""
    file = await get_owned(db, File, file_id, user_id)
    return file if file and file.deleted_at is None else None


async def get_user_folder(db: AsyncSession, user_id, folder_id):
    """读取当前用户的文件夹。"""
    return await get_owned(db, Folder, folder_id, user_id)


async def find_user_files_by_name(db: AsyncSession, user_id, base_name: str):
    """按文件名查找当前用户存活文件，精确结果优先。"""
    base_stmt = select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
    rows = (await db.execute(base_stmt.where(File.display_name == base_name))).scalars().all()
    if not rows:
        rows = (await db.execute(
            base_stmt.where(File.display_name.ilike(f"%{base_name}%"))
        )).scalars().all()
    return rows


async def find_user_folders_by_name(db: AsyncSession, user_id, name: str, *, space=None, project_id=None):
    """按名称查找当前用户文件夹；调用方负责处理重名提示。"""
    stmt = select(Folder).where(Folder.user_id == user_id, Folder.name == name)
    if space == "project" and project_id:
        stmt = stmt.where(Folder.project_id == project_id)
    elif space and space != "project":
        stmt = stmt.where(Folder.project_id.is_(None))
    return (await db.execute(stmt)).scalars().all()


async def list_user_folders(db: AsyncSession, user_id, *, project_id=None, parent_id=None):
    """查询当前用户存活文件夹。"""
    stmt = select(Folder).where(
        Folder.user_id == user_id,
        Folder.deleted_at.is_(None),
    )
    if project_id is not None:
        stmt = stmt.where(Folder.project_id == project_id)
    if parent_id is not None:
        stmt = stmt.where(Folder.parent_id == parent_id)
    return (await db.execute(stmt)).scalars().all()


async def list_folder_rows_with_file_counts(
    db: AsyncSession,
    user_id,
    *,
    project_id=None,
    parent_id=None,
    all_folders=False,
):
    """查询文件夹及其直属存活文件数，统一应用用户和软删边界。"""
    stmt = select(Folder).where(
        Folder.user_id == user_id,
        Folder.deleted_at.is_(None),
    )
    if not all_folders:
        stmt = stmt.where(
            Folder.project_id == project_id if project_id is not None
            else Folder.project_id.is_(None),
            Folder.parent_id == parent_id if parent_id is not None
            else Folder.parent_id.is_(None),
        )
    folders = (await db.execute(stmt.order_by(Folder.created_at))).scalars().all()
    if not folders:
        return []
    counts = await db.execute(
        select(File.folder_id, func.count().label("cnt")).where(
            File.user_id == user_id,
            File.folder_id.in_([folder.id for folder in folders]),
            File.deleted_at.is_(None),
        ).group_by(File.folder_id)
    )
    count_map = {row.folder_id: row.cnt for row in counts}
    return [(folder, count_map.get(folder.id, 0)) for folder in folders]


async def file_count_for_folder(db: AsyncSession, user_id, folder_id: int) -> int:
    """统计当前用户文件夹直属存活文件数。"""
    return (await db.execute(
        select(func.count()).select_from(File).where(
            File.user_id == user_id,
            File.folder_id == folder_id,
            File.deleted_at.is_(None),
        )
    )).scalar_one()


async def descendant_folder_ids(db: AsyncSession, user_id, root_id: int) -> list[int]:
    """按归属查询文件夹子树 ID。"""
    ids = [root_id]
    frontier = [root_id]
    while frontier:
        rows = (await db.execute(
            select(Folder.id).where(
                Folder.user_id == user_id,
                Folder.parent_id.in_(frontier),
            )
        )).scalars().all()
        fresh = [item for item in rows if item not in ids]
        ids.extend(fresh)
        frontier = fresh
    return ids
