from typing import Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File


def parse_upload_filename(filename: str) -> Tuple[str, str]:
    parts = filename.rsplit('.', 1)
    return parts[0], parts[1].upper()[:10] if len(parts) > 1 else 'FILE'


async def find_conflict(
    db: AsyncSession,
    user_id: int,
    space: str,
    project_id: Optional[int],
    folder_id: Optional[int],
    display_name: str,
    ext: str,
) -> Optional[File]:
    stmt = select(File).where(
        File.user_id == user_id,
        File.deleted_at.is_(None),
        File.space == space,
        File.display_name == display_name,
        File.ext == ext.upper(),
    )
    stmt = stmt.where(File.project_id == project_id) if project_id is not None else stmt.where(File.project_id.is_(None))
    stmt = stmt.where(File.folder_id == folder_id) if folder_id is not None else stmt.where(File.folder_id.is_(None))
    return (await db.execute(stmt)).scalars().first()
