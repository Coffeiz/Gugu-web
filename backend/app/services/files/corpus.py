"""文件正文检索语料查询：grep 工具的 ORM 边界收口在 Service 层。"""
from __future__ import annotations

from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import File, Folder, Project, WorkspaceDirectory


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


def _safe_component(value: object) -> str:
    return str(value or "").replace("/", "_").replace("\\", "_").strip()


async def _load_grep_path_metadata(db, *, user_id: str, files: list[File]):
    project_ids = {file.project_id for file in files if file.space == "project" and file.project_id is not None}
    workspace_ids = {
        file.workspace_directory_id
        for file in files
        if file.space == "workspace" and file.workspace_directory_id is not None
    }
    folder_ids = {file.folder_id for file in files if file.folder_id is not None}

    projects: dict[int, Project] = {}
    if project_ids:
        projects = {
            row.id: row
            for row in (await db.scalars(select(Project).where(
                Project.user_id == user_id,
                Project.id.in_(project_ids),
            ))).all()
        }
        for project_id in project_ids - projects.keys():
            await get_owned(db, Project, project_id, user_id)

    workspaces: dict[int, WorkspaceDirectory] = {}
    if workspace_ids:
        workspaces = {
            row.id: row
            for row in (await db.scalars(select(WorkspaceDirectory).where(
                WorkspaceDirectory.user_id == user_id,
                WorkspaceDirectory.id.in_(workspace_ids),
            ))).all()
        }
        for workspace_id in workspace_ids - workspaces.keys():
            await get_owned(db, WorkspaceDirectory, workspace_id, user_id)

    folders = await _load_grep_folder_tree(db, user_id=user_id, folder_ids=folder_ids)
    return projects, workspaces, folders


async def _load_grep_folder_tree(db, *, user_id: str, folder_ids: set[int]) -> dict[int, Folder]:
    # 逐层批量取父节点：查询次数取决于目录深度，而不是文件数；user_id 条件同时
    # 保证坏链/伪造的跨用户父目录不会泄露名称或被纳入路径。
    folders: dict[int, Folder] = {}
    pending_ids = folder_ids
    queried_folder_ids: set[int] = set()
    while pending_ids:
        queried_folder_ids.update(pending_ids)
        batch = (await db.scalars(select(Folder).where(
            Folder.user_id == user_id,
            Folder.id.in_(pending_ids),
        ))).all()
        for folder in batch:
            folders[folder.id] = folder
        pending_ids = {
            folder.parent_id
            for folder in batch
            if folder.parent_id is not None and folder.parent_id not in folders
        }
    for folder_id in queried_folder_ids - folders.keys():
        await get_owned(db, Folder, folder_id, user_id)
    return folders


def _grep_folder_path(
    folder_id: int,
    *,
    project_id: int | None,
    workspace_id: int | None,
    folders: dict[int, Folder],
    cache: dict[tuple[int, int | None, int | None], str | None],
) -> str | None:
    cache_key = (folder_id, project_id, workspace_id)
    if cache_key in cache:
        return cache[cache_key]

    names = []
    current_id: int | None = folder_id
    seen: set[int] = set()
    while current_id is not None:
        current = folders.get(current_id)
        if current_id in seen or current is None:
            cache[cache_key] = None
            return None
        seen.add(current_id)
        if current.project_id != project_id or current.workspace_directory_id != workspace_id:
            cache[cache_key] = None
            return None
        names.append(current.name)
        current_id = current.parent_id

    resolved = "/".join(reversed(names))
    cache[cache_key] = resolved
    return resolved


def _grep_logical_path(
    file: File,
    *,
    projects: dict[int, Project],
    workspaces: dict[int, WorkspaceDirectory],
    folders: dict[int, Folder],
    folder_cache: dict[tuple[int, int | None, int | None], str | None],
) -> str | None:
    if file.space == "personal":
        parts = ["personal"]
        project_id = workspace_id = None
    elif file.space == "project":
        project = projects.get(file.project_id)
        if project is None:
            return None
        parts = ["project", _safe_component(project.name)]
        project_id, workspace_id = file.project_id, None
    elif file.space == "workspace":
        workspace = workspaces.get(file.workspace_directory_id)
        if workspace is None or workspace.deleted_at is not None:
            return None
        parts = ["workspace", _safe_component(workspace.directory_name)]
        project_id, workspace_id = None, file.workspace_directory_id
    else:
        return None

    if file.folder_id is not None:
        relative = _grep_folder_path(
            file.folder_id,
            project_id=project_id,
            workspace_id=workspace_id,
            folders=folders,
            cache=folder_cache,
        )
        if relative is None:
            return None
        parts.extend(_safe_component(part) for part in relative.split("/") if part)

    filename = f"{file.display_name}.{file.ext}" if file.ext else file.display_name
    if filename:
        parts.append(_safe_component(filename))
    return "/" + "/".join(parts)


async def resolve_grep_candidate_paths(db, *, user_id: str, files: list[File]) -> dict[int, str | None]:
    """批量解析文件逻辑路径，避免逐文件查询项目、Workspace 和文件夹祖先。"""
    projects, workspaces, folders = await _load_grep_path_metadata(
        db, user_id=user_id, files=files,
    )
    folder_cache: dict[tuple[int, int | None, int | None], str | None] = {}
    return {
        file.id: _grep_logical_path(
            file,
            projects=projects,
            workspaces=workspaces,
            folders=folders,
            folder_cache=folder_cache,
        )
        for file in files
    }
