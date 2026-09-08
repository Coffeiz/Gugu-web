"""文件正文检索语料查询：grep 工具的 ORM 边界收口在 Service 层。"""
from __future__ import annotations

from sqlalchemy import select

from app.models import File


async def list_grep_candidates(
    db, *, user_id: str, spaces: tuple[str, ...] = ("personal", "project", "workspace"),
) -> list[File]:
    """按 user_id 隔离取未删除、处于可检索空间的文件元数据，最近更新优先。"""
    rows = (await db.execute(
        select(File).where(
            File.user_id == user_id,
            File.deleted_at.is_(None),
            File.space.in_(spaces),
        ).order_by(File.updated_at.desc())
    )).scalars().all()
    return list(rows)
