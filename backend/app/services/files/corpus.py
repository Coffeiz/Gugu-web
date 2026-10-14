"""文件正文检索语料查询：grep 工具的 ORM 边界收口在 Service 层。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath

from sqlalchemy import and_, case, func, literal, or_, select

from app.core.ownership import get_owned
from app.models import File, Folder, Project, WorkspaceDirectory


@dataclass(slots=True)
class GrepFileCandidate:
    """grep 所需的最小文件元数据投影，避免为全量候选创建 ORM 实体。"""

    id: int
    display_name: str
    ext: str
    space: str
    project_id: int | None
    workspace_directory_id: int | None
    folder_id: int | None
    storage_key: str
    size_bytes: int
    mime_type: str | None


async def list_grep_candidates(
    db,
    *,
    user_id: str,
    spaces: tuple[str, ...] = ("personal", "project", "workspace"),
    requested_path: str | None = None,
) -> list[GrepFileCandidate]:
    """按 user_id 隔离取 grep 所需的最小文件元数据，最近更新优先。"""
    stmt = select(
        File.id,
        File.display_name,
        File.ext,
        File.space,
        File.project_id,
        File.workspace_directory_id,
        File.folder_id,
        File.storage_key,
        File.size_bytes,
        File.mime_type,
    ).where(
        File.user_id == user_id,
        File.deleted_at.is_(None),
        File.space.in_(spaces),
    )
    if requested_path:
        candidate_filter = await _grep_path_candidate_filter(
            db, user_id=user_id, requested_path=requested_path,
        )
        if candidate_filter is not None:
            stmt = stmt.where(candidate_filter)
    rows = (await db.execute(stmt.order_by(File.updated_at.desc()))).all()
    return [GrepFileCandidate(*row) for row in rows]


async def _grep_path_candidate_filter(db, *, user_id: str, requested_path: str):
    """把逻辑路径约束下推到文件候选 SQL，仍由路径解析器做最终校验。"""
    parts = requested_path.strip("/").split("/")
    space = parts[0]
    tail = parts[1:]
    file_scope, folder_scope, tail = await _grep_path_scope(
        db, user_id=user_id, space=space, tail=tail,
    )
    if file_scope is False:
        return False
    if not tail:
        return and_(*file_scope) if file_scope else None

    directory_ids = await _resolve_grep_folder_ids(
        db, user_id=user_id, segments=tail, folder_scope=folder_scope,
    )
    descendant_ids = await _grep_folder_descendant_ids(
        db, user_id=user_id, folder_ids=directory_ids, folder_scope=folder_scope,
    )
    conditions = [File.folder_id.in_(descendant_ids)] if descendant_ids else []
    filename = tail[-1]
    parent_ids = await _resolve_grep_folder_ids(
        db, user_id=user_id, segments=tail[:-1], folder_scope=folder_scope,
    ) if len(tail) > 1 else set()
    if len(tail) == 1 or parent_ids:
        parent_filter = File.folder_id.in_(parent_ids) if parent_ids else File.folder_id.is_(None)
        conditions.append(parent_filter & _grep_filename_matches(filename))
    if not conditions:
        return False
    path_filter = or_(*conditions)
    return and_(*file_scope, path_filter) if file_scope else path_filter


async def _grep_path_scope(db, *, user_id: str, space: str, tail: list[str]):
    if space == "personal":
        return [], [Folder.project_id.is_(None), Folder.workspace_directory_id.is_(None)], tail
    if space == "project":
        projects = (await db.scalars(select(Project).where(
            Project.user_id == user_id,
            or_(
                Project.name == tail[0],
                Project.name.contains("/"),
                Project.name.contains("\\"),
                func.trim(Project.name) != Project.name,
            ),
        ))).all()
        project_ids = [project.id for project in projects if _safe_component(project.name) == tail[0]]
        if not project_ids:
            return False, [], []
        return (
            [File.project_id.in_(project_ids)],
            [Folder.project_id.in_(project_ids), Folder.workspace_directory_id.is_(None)],
            tail[1:],
        )
    if space == "workspace":
        workspaces = (await db.scalars(select(WorkspaceDirectory).where(
            WorkspaceDirectory.user_id == user_id,
            WorkspaceDirectory.deleted_at.is_(None),
            or_(
                WorkspaceDirectory.directory_name == tail[0],
                WorkspaceDirectory.directory_name.contains("/"),
                WorkspaceDirectory.directory_name.contains("\\"),
                func.trim(WorkspaceDirectory.directory_name) != WorkspaceDirectory.directory_name,
            ),
        ))).all()
        workspace_ids = [
            workspace.id for workspace in workspaces
            if _safe_component(workspace.directory_name) == tail[0]
        ]
        if not workspace_ids:
            return False, [], []
        return (
            [File.workspace_directory_id.in_(workspace_ids)],
            [Folder.workspace_directory_id.in_(workspace_ids), Folder.project_id.is_(None)],
            tail[1:],
        )
    return False, [], []


async def _resolve_grep_folder_ids(db, *, user_id: str, segments: list[str], folder_scope) -> set[int]:
    parent_ids: set[int] | None = None
    for segment in segments:
        stmt = select(Folder).where(
            Folder.user_id == user_id,
            *folder_scope,
            or_(
                Folder.name == segment,
                Folder.name.contains("/"),
                Folder.name.contains("\\"),
                func.trim(Folder.name) != Folder.name,
            ),
        )
        if parent_ids is None:
            stmt = stmt.where(Folder.parent_id.is_(None))
        elif not parent_ids:
            return set()
        else:
            stmt = stmt.where(Folder.parent_id.in_(parent_ids))
        folders = (await db.scalars(stmt)).all()
        parent_ids = {folder.id for folder in folders if _safe_component(folder.name) == segment}
        if not parent_ids:
            return set()
    return parent_ids or set()


async def _grep_folder_descendant_ids(db, *, user_id: str, folder_ids: set[int], folder_scope) -> set[int]:
    descendants = set(folder_ids)
    frontier = set(folder_ids)
    while frontier:
        children = set((await db.scalars(select(Folder.id).where(
            Folder.user_id == user_id,
            Folder.parent_id.in_(frontier),
            *folder_scope,
        ))).all()) - descendants
        descendants.update(children)
        frontier = children
    return descendants


def _grep_filename_matches(filename: str):
    stored_filename = case(
        (File.ext != "", File.display_name + literal(".") + File.ext),
        else_=File.display_name,
    )
    normalized_filename = func.replace(
        func.replace(func.trim(stored_filename), "/", "_"), "\\", "_",
    )
    return normalized_filename == filename


def normalize_file_logical_path(value: str | None) -> str | None:
    """验证并规范化文件工具共用的虚拟逻辑路径。"""
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text.startswith("/") or "\\" in text or "\x00" in text:
        raise ValueError("路径必须是 /personal、/project 或 /workspace 下的逻辑路径")
    raw_parts = text[1:].split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise ValueError("路径不能包含空目录、. 或 ..")
    parts = PurePosixPath(text).parts
    if len(parts) < 2 or parts[0] != "/" or parts[1] not in {"personal", "project", "workspace"}:
        raise ValueError("路径只允许 /personal、/project 或 /workspace")
    if any(part in {"", ".", ".."} for part in parts[2:]):
        raise ValueError("路径不能包含 . 或 ..")
    return "/" + "/".join(parts[1:])


async def find_user_file_by_logical_path(db, *, user_id: str, path: str) -> list[File]:
    """按 grep/list_dir 使用的逻辑路径精确定位当前用户已登记文件。"""
    from sqlalchemy import literal

    normalized = normalize_file_logical_path(path)
    if normalized is None:
        return []
    parts = normalized.split("/")
    if len(parts) < 3:
        raise ValueError("文件路径还需要包含文件名")
    space, filename = parts[1], parts[-1]
    stmt = select(File).where(
        File.user_id == user_id,
        File.deleted_at.is_(None),
        File.space == space,
        or_(
            File.display_name == filename,
            File.display_name + literal(".") + File.ext == filename,
        ),
    )
    candidates = list((await db.scalars(stmt)).all())
    if not candidates:
        return []
    paths = await resolve_grep_candidate_paths(db, user_id=user_id, files=candidates)
    return [file for file in candidates if paths.get(file.id) == normalized]


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
