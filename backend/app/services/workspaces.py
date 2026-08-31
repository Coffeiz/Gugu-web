"""工作区归属与会话绑定服务。

这里只负责声明、归属和绑定；Shell 范围由会话绑定状态派生，执行器及沙盒留在执行层。
"""
from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from pathlib import Path

from app.models import ConversationSession, Folder, Project, UserPreferences, Workspace
from app.core.ownership import get_owned
from app.core.config import get_settings
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import compose_logical_path
from app.services.storage.quota_ledger import ensure_user_storage_space, SHELL_PERSISTENT


async def get_workspace(db: AsyncSession, user_id, workspace_id: int) -> Workspace | None:
    return await get_owned(db, Workspace, workspace_id, user_id)


async def list_workspaces(db: AsyncSession, user_id) -> list[Workspace]:
    """列出当前用户可绑定的启用工作区。"""
    result = await db.execute(
        select(Workspace)
        .where(Workspace.user_id == user_id, Workspace.enabled.is_(True))
        .order_by(Workspace.updated_at.desc(), Workspace.id.desc())
    )
    return list(result.scalars().all())


async def list_workspaces_for_management(db: AsyncSession, user_id) -> list[Workspace]:
    """列出当前用户全部工作区，包含停用项供管理工具使用。"""
    result = await db.execute(
        select(Workspace)
        .where(Workspace.user_id == user_id)
        .order_by(Workspace.updated_at.desc(), Workspace.id.desc())
    )
    return list(result.scalars().all())


async def workspace_payload(db: AsyncSession, user_id, row: Workspace) -> dict:
    """构造工作区工具结果，并在服务层完成关联对象的归属查询。"""
    count = await db.scalar(
        select(func.count(ConversationSession.id)).where(
            ConversationSession.user_id == user_id,
            ConversationSession.workspace_id == row.id,
        )
    )
    result = {
        "workspace_id": row.id,
        "name": row.name,
        "kind": row.kind,
        "enabled": row.enabled,
        "is_default": row.is_default,
        "bound_session_count": int(count or 0),
        "project_id": row.project_id,
        "folder_id": row.folder_id,
    }
    if row.project_id is not None:
        project = await get_owned(db, Project, row.project_id, user_id)
        result["project_name"] = project.name if project else None
    if row.folder_id is not None:
        folder = await get_owned(db, Folder, row.folder_id, user_id)
        result["folder_name"] = folder.name if folder else None
    return result


async def create_workspace(
    db: AsyncSession, user_id, *, name: str, kind: str,
    folder_id: int | None = None, project_id: int | None = None,
    enabled: bool = True,
) -> Workspace:
    if kind == "folder":
        if folder_id is None or await get_owned(db, Folder, folder_id, user_id) is None:
            raise ValueError("文件夹不存在")
        project_id = None
    elif kind == "project":
        if project_id is None or await get_owned(db, Project, project_id, user_id) is None:
            raise ValueError("项目不存在")
        folder_id = None
    else:
        raise ValueError("工作区类型无效")

    workspace = Workspace(
        user_id=user_id, name=name.strip(), kind=kind,
        folder_id=folder_id, project_id=project_id, enabled=enabled,
    )
    db.add(workspace)
    await db.flush()
    return workspace


async def update_workspace(
    db: AsyncSession, user_id, workspace_id: int, *,
    name: str | None = None, enabled: bool | None = None,
) -> Workspace:
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None:
        raise LookupError("工作区不存在")
    if name is not None:
        normalized = name.strip()
        if not normalized:
            raise ValueError("工作区名称不能为空")
        workspace.name = normalized
    if enabled is not None:
        workspace.enabled = enabled
    await db.flush()
    return workspace


async def delete_workspace(db: AsyncSession, user_id, workspace_id: int) -> None:
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None:
        raise LookupError("工作区不存在")
    # 显式解除绑定，确保测试数据库与生产数据库的 ON DELETE 行为一致。
    sessions = (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_id,
            ConversationSession.workspace_id == workspace.id,
        )
    )).scalars().all()
    for session in sessions:
        session.workspace_id = None
    await db.delete(workspace)
    await db.flush()


async def bind_session(db: AsyncSession, user_id, session_id: int, workspace_id: int | None) -> ConversationSession:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None:
        raise LookupError("会话不存在")
    if workspace_id is None:
        session.workspace_id = None
    else:
        workspace = await get_workspace(db, user_id, workspace_id)
        if workspace is None or not workspace.enabled:
            raise LookupError("工作区不存在或已停用")
        session.workspace_id = workspace.id
    await db.flush()
    return session


async def effective_shell_enabled(db: AsyncSession, user_id) -> bool:
    """返回用户级开关；全局开关由调用方与本函数结果做 AND。"""
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_enabled", False))


async def effective_shell_system_enabled(db: AsyncSession, user_id) -> bool:
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_system_enabled", False))


async def effective_shell_dangerous_enabled(db: AsyncSession, user_id) -> bool:
    """读取用户危险 Shell 命令开关；它不能绕过 Admin 开关或确认门。"""
    result = await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )
    prefs = result.scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_dangerous_enabled", False))


async def effective_shell_autopilot_enabled(db: AsyncSession, user_id) -> bool:
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_autopilot_enabled", False))


async def describe_session(db: AsyncSession, user_id, session_id: int) -> Workspace | None:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None or session.workspace_id is None:
        return None
    return await get_workspace(db, user_id, session.workspace_id)


async def resolve_workspace_target(
    db: AsyncSession, user_id, workspace_id: int,
) -> dict | None:
    """解析会话工作区对应的文件库规范落点。

    工作区 id 与项目/文件夹 id 属于不同命名空间；文件工具只消费这里返回的
    ``space/project_id/folder_id``，避免把同数值的 workspace_id 误当成 project_id。
    """
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None or not workspace.enabled:
        return None
    if workspace.kind == "project" and workspace.project_id is not None:
        project = await get_owned(db, Project, workspace.project_id, user_id)
        if project is None:
            return None
        return {
            "workspace_id": workspace.id, "workspace_name": workspace.name,
            "kind": "project", "space": "project",
            "project_id": project.id, "folder_id": None,
            "project_name": project.name,
        }
    if workspace.kind == "folder" and workspace.folder_id is not None:
        folder = await get_owned(db, Folder, workspace.folder_id, user_id)
        if folder is None or folder.deleted_at is not None:
            return None
        if folder.project_id is None:
            return {
                "workspace_id": workspace.id, "workspace_name": workspace.name,
                "kind": "folder", "space": "personal",
                "project_id": None, "folder_id": folder.id,
                "folder_name": folder.name,
            }
        project = await get_owned(db, Project, folder.project_id, user_id)
        if project is None:
            return None
        return {
            "workspace_id": workspace.id, "workspace_name": workspace.name,
            "kind": "folder", "space": "project",
            "project_id": project.id, "folder_id": folder.id,
            "project_name": project.name, "folder_name": folder.name,
        }
    return None


async def resolve_workspace_root(db: AsyncSession, user_id, workspace_id: int) -> Path | None:
    """把已归属的工作区解析为本地存储根下的真实目录。

    只返回本地存储路径；远程存储后端不能被本机执行器隐式当成本地目录使用。
    """
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None or not workspace.enabled:
        return None
    settings = get_settings()
    # OSS 只决定文件库对象如何存储；Shell 仍需要一块本地、独立的执行空间。
    # 该目录不作为 OSS 对象路径使用，也不与旧 backend/uploads 混用。
    if settings.storage.backend not in {"local", "oss"}:
        return None

    logical = None
    if workspace.kind == "project" and workspace.project_id is not None:
        project = await get_owned(db, Project, workspace.project_id, user_id)
        if project is None:
            return None
        date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
        logical = compose_logical_path(
            "project", project_name=project.name, project_id=project.id,
            project_year=date_str[:4], project_month=date_str[5:7],
        )
    elif workspace.kind == "folder" and workspace.folder_id is not None:
        folder = await get_owned(db, Folder, workspace.folder_id, user_id)
        if folder is None or folder.deleted_at is not None:
            return None
        resolved = await resolve_folder_path(db, user_id, folder.id, folder.project_id)
        if not resolved:
            return None
        _, folder_path = resolved
        if folder.project_id is None:
            logical = compose_logical_path("personal", folder_path=folder_path)
        else:
            project = await get_owned(db, Project, folder.project_id, user_id)
            if project is None:
                return None
            date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
            logical = compose_logical_path(
                "project", project_name=project.name, project_id=project.id,
                project_year=date_str[:4], project_month=date_str[5:7],
                folder_path=folder_path,
            )
    if not logical:
        return None
    return (Path(settings.storage.local_path).resolve() / str(user_id) / logical).resolve()


async def resolve_sandbox_root(db: AsyncSession, user_id) -> Path | None:
    """解析用户独立 Shell 持久根目录，不与文件库个人根目录混用。"""
    settings = get_settings()
    if settings.storage.backend not in {"local", "oss"}:
        return None
    if db is None:
        # 纯路径解析测试/启动探测没有数据库上下文，不能伪造配额登记；正式
        # Shell 请求始终传入 AsyncSession，并走统一账本初始化。
        from agent.sandbox.quota import ensure_sandbox_root
        root = (Path(settings.storage.local_path).resolve() / str(user_id) / "shell").resolve()
        return ensure_sandbox_root(root)
    rows = await ensure_user_storage_space(db, user_id)
    row = next(item for item in rows if item.category == SHELL_PERSISTENT)
    return Path(row.root_path).resolve()


async def resolve_shell_root(db: AsyncSession, user_id, scope: str, workspace_id: int | None) -> Path | None:
    if scope == "sandbox" and workspace_id:
        return await resolve_workspace_root(db, user_id, workspace_id) if workspace_id else None
    if scope == "sandbox":
        return await resolve_sandbox_root(db, user_id)
    if scope == "system":
        return Path("/").resolve()
    return None
