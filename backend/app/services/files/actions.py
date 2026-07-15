"""文件操作的跨资源编排。

单文件的领域写入仍由 Storage FileService 负责；这里承载需要协调回收站、
数据库会话和批量输入的文件库动作，避免路由重复拼装同一套删除流程。
"""

from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.files.selection import move_file_to_trash_by_id, move_files_to_trash


async def delete_file(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
    deleted_at: datetime,
) -> bool:
    """将一个当前用户的存活文件移入回收站。"""
    return await move_file_to_trash_by_id(db, storage, user_id, file_id, deleted_at)


async def delete_files(
    db: AsyncSession,
    storage,
    user_id: int,
    file_ids: list[int],
    deleted_at: datetime,
) -> list[int]:
    """将一批当前用户的存活文件移入回收站，返回实际处理的 ID。"""
    return await move_files_to_trash(db, storage, user_id, file_ids, deleted_at)
