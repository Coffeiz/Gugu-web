import asyncio
from typing import Optional

from sqlalchemy import Select, func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Folder, Project
from app.services.storage import LocalStorageBackend

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
