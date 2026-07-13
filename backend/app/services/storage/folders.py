"""文件夹层级解析与物理文件归位。"""
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import File, Folder, Project
from app.services.storage import get_storage
from app.services.storage.keys import _build_key, _resolve_conflict


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


async def _descendant_folder_ids(
    db: AsyncSession,
    user_id,
    root_id: int,
) -> List[int]:
    """返回根文件夹及全部子孙；移动/改名后所有层级的物理 key 都依赖它。"""
    ids = [root_id]
    frontier = [root_id]
    while frontier:
        children = (await db.execute(
            select(Folder.id).where(
                Folder.user_id == user_id,
                Folder.parent_id.in_(frontier),
            )
        )).scalars().all()
        frontier = [folder_id for folder_id in children if folder_id not in ids]
        ids.extend(frontier)
    return ids


async def relocate_folder_tree_files(
    db: AsyncSession,
    user_id,
    root_folder_id: int,
) -> int:
    """按当前文件夹树重搬所有后代文件，并同步空间/项目归属。

    存储 key 内含根到叶的文件夹路径，所以同一空间内的改名、移动也不能只改
    ``Folder.parent_id``/``Folder.name``。本函数是 REST 与咕咕移动文件夹共用的唯一入口。
    调用者须先在当前事务里写入新的文件夹关系并 ``flush``，再调用本函数，最后统一 commit。
    """
    folder_ids = await _descendant_folder_ids(db, user_id, root_folder_id)
    folders = (await db.execute(
        select(Folder).where(Folder.user_id == user_id, Folder.id.in_(folder_ids))
    )).scalars().all()
    folder_by_id: Dict[int, Folder] = {folder.id: folder for folder in folders}
    files = (await db.execute(
        select(File).where(
            File.user_id == user_id,
            File.folder_id.in_(folder_ids),
            File.deleted_at.is_(None),
        )
    )).scalars().all()

    projects: Dict[int, Project] = {}
    storage = get_storage()
    moved = 0
    for file in files:
        folder = folder_by_id.get(file.folder_id)
        if not folder:
            raise ValueError("文件夹树状态异常")
        project_id = folder.project_id
        project_name = project_year = project_month = ""
        if project_id is not None:
            project = projects.get(project_id)
            if project is None:
                project = await get_owned(db, Project, project_id, user_id)
                if project is None:
                    raise ValueError("文件夹所属项目不存在")
                projects[project_id] = project
            project_name = project.name
            date_value = project.start_date or project.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_value[:4], date_value[5:7]

        resolved = await resolve_folder_path(db, user_id, folder.id, project_id)
        if not resolved:
            raise ValueError("文件夹层级无效")
        _, folder_path = resolved
        new_key = _build_key(
            uid=user_id,
            space="project" if project_id is not None else "personal",
            display_name=file.display_name,
            ext=file.ext,
            project_name=project_name,
            project_id=project_id or 0,
            project_year=project_year,
            project_month=project_month,
            folder_path=folder_path,
        )
        new_name = file.display_name
        if new_key != file.storage_key:
            new_key, new_name = await _resolve_conflict(storage, new_key, new_name, file.ext)
            await storage.rename_file(file.storage_key, new_key)
            file.storage_key = new_key
            file.display_name = new_name
            moved += 1
        file.space = "project" if project_id is not None else "personal"
        file.project_id = project_id
    return moved
