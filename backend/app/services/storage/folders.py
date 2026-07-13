"""文件夹层级解析：给存储 key 与 Agent 回执提供同一份完整路径。"""
from typing import Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import Folder


async def resolve_folder_path(
    db: AsyncSession,
    user_id,
    folder_id: int,
    project_id: Optional[int],
) -> Optional[Tuple[Folder, str]]:
    """返回归属已验证的文件夹和根到叶的路径；空间/项目不一致或坏链一律视为无效。"""
    folder = await get_owned(db, Folder, folder_id, user_id)
    if not folder or folder.project_id != project_id:
        return None

    parts = []
    current = folder
    seen = set()
    while current:
        if current.id in seen or current.project_id != project_id:
            return None
        seen.add(current.id)
        parts.append(current.name)
        if current.parent_id is None:
            break
        current = await get_owned(db, Folder, current.parent_id, user_id)
        if not current:
            return None
    return folder, "/".join(reversed(parts))
