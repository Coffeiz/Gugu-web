"""文件库投影使用的路径归属与目录链解析。"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import Folder, Project, WorkspaceDirectory
from app.services.filesync.file_ops import file_name
from app.services.workspaces import get_workspace


async def ensure_folder_path(
    db: AsyncSession,
    user_id,
    *,
    space: str,
    project_id: int | None,
    folder_names: list[str],
    workspace_directory_id: int | None = None,
) -> tuple[int | None, bool]:
    """确保目录链存在，并报告本次是否新建了任一层。"""
    parent_id = None
    created = False
    for name in folder_names:
        folder = await db.scalar(select(Folder).where(
            Folder.user_id == user_id, Folder.project_id == project_id,
            Folder.parent_id == parent_id, Folder.name == name,
            Folder.workspace_directory_id == workspace_directory_id,
            Folder.deleted_at.is_(None),
        ))
        if folder is None:
            folder = Folder(
                user_id=user_id, project_id=project_id, parent_id=parent_id,
                workspace_directory_id=workspace_directory_id, name=name,
            )
            db.add(folder)
            await db.flush()
            created = True
        parent_id = folder.id
    return parent_id, created


async def folder_for_path(
    db: AsyncSession,
    user_id,
    *,
    space: str,
    project_id: int | None,
    folder_names: list[str],
    workspace_directory_id: int | None = None,
) -> int | None:
    folder_id, _ = await ensure_folder_path(
        db, user_id, space=space, project_id=project_id,
        folder_names=folder_names,
        workspace_directory_id=workspace_directory_id,
    )
    return folder_id


async def find_folder_path(
    db: AsyncSession,
    user_id,
    *,
    space: str,
    project_id: int | None,
    folder_names: list[str],
    workspace_directory_id: int | None = None,
) -> int | None:
    """只读定位目录链，任何一层缺失即返回 None；不创建。"""
    parent_id = None
    for name in folder_names:
        folder = await db.scalar(select(Folder).where(
            Folder.user_id == user_id, Folder.project_id == project_id,
            Folder.parent_id == parent_id, Folder.name == name,
            Folder.workspace_directory_id == workspace_directory_id,
            Folder.deleted_at.is_(None),
        ))
        if folder is None:
            return None
        parent_id = folder.id
    return parent_id


def parse_directory_path(
    path: Path, user_root: Path,
) -> tuple[str, int | None, list[str]] | None:
    parts = path.relative_to(user_root).parts
    if not parts:
        return None
    if parts[0] == "个人文件" and len(parts) > 1:
        return "personal", None, list(parts[1:])
    if parts[0] == "项目文件" and len(parts) > 3:
        project_dir = parts[3]
        if "#" not in project_dir:
            return None
        try:
            project_id = int(project_dir.rsplit("#", 1)[1].strip())
        except ValueError:
            return None
        folder_names = list(parts[4:])
        return ("project", project_id, folder_names) if folder_names else None
    return None


async def classify_path(
    db: AsyncSession,
    user_id,
    path: Path,
    user_root: Path,
    *,
    workspace_directory_id: int | None = None,
    base: Path | None = None,
):
    """把 canonical 本地路径解析为 File 的归属字段。"""
    if workspace_directory_id is not None:
        parts = path.relative_to(base or user_root).parts
        if not parts:
            raise ValueError("同步文件缺少空间路径")
        display_name, ext = file_name(Path(parts[-1]))
        space = "workspace"
        folder_id = await folder_for_path(
            db, user_id, space=space, project_id=None,
            folder_names=list(parts[:-1]),
            workspace_directory_id=workspace_directory_id,
        )
        return space, None, folder_id, display_name, ext, workspace_directory_id

    parts = path.relative_to(user_root).parts
    if len(parts) < 2:
        raise ValueError("同步文件缺少空间路径")
    space_root, *rest = parts
    filename = rest.pop()
    if space_root == "个人文件":
        project_id = None
        space = "personal"
        folder_names = list(rest)
    elif space_root == "项目文件" and len(rest) >= 3:
        project_dir = rest[2]
        if "#" not in project_dir:
            raise ValueError("项目路径缺少项目标识")
        try:
            project_id = int(project_dir.rsplit("#", 1)[1].strip())
        except ValueError as exc:
            raise ValueError("项目路径标识无效") from exc
        if await get_owned(db, Project, project_id, user_id) is None:
            raise ValueError("项目不属于当前用户")
        space = "project"
        folder_names = list(rest[3:])
    else:
        raise ValueError("同步只支持个人文件和项目文件")
    display_name, ext = file_name(Path(filename))
    folder_id = await folder_for_path(
        db, user_id, space=space, project_id=project_id,
        folder_names=folder_names,
    )
    return space, project_id, folder_id, display_name, ext, None


async def workspace_directory_id_for(
    db: AsyncSession, user_id, workspace_id: int,
) -> int | None:
    """解析 directory 型工作区的文件库目录归属。"""
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None or workspace.kind != "directory" or workspace.directory_id is None:
        return None
    directory = await get_owned(db, WorkspaceDirectory, workspace.directory_id, user_id)
    if directory is None or directory.deleted_at is not None:
        return None
    return directory.id
