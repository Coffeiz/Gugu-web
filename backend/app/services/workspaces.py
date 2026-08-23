"""工作区归属与会话绑定服务。

这里只负责声明、归属和绑定；Shell 范围由会话绑定状态派生，执行器及沙盒留在执行层。
"""
from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from pathlib import Path

from app.models import ConversationSession, Folder, Project, UserPreferences, Workspace
from app.core.ownership import get_owned
from app.core.config import get_settings
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import compose_logical_path


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


async def effective_shell_personal_enabled(db: AsyncSession, user_id) -> bool:
    prefs = (await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )).scalar_one_or_none()
    return bool(prefs and prefs.data.get("shell_personal_enabled", False))


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


async def describe_session(db: AsyncSession, user_id, session_id: int) -> Workspace | None:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None or session.workspace_id is None:
        return None
    return await get_workspace(db, user_id, session.workspace_id)


async def get_session_shell_scope(db: AsyncSession, user_id, session_id: int) -> str:
    """根据会话绑定状态派生 Shell 范围，不读取可手动漂移的旧字段。"""
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None:
        raise LookupError("会话不存在")
    return "workspace" if session.workspace_id is not None else "system"


async def resolve_workspace_root(db: AsyncSession, user_id, workspace_id: int) -> Path | None:
    """把已归属的工作区解析为本地存储根下的真实目录。

    只返回本地存储路径；远程存储后端不能被本机执行器隐式当成本地目录使用。
    """
    workspace = await get_workspace(db, user_id, workspace_id)
    if workspace is None or not workspace.enabled:
        return None
    settings = get_settings()
    if settings.storage.backend != "local":
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


async def resolve_personal_shell_root(db: AsyncSession, user_id) -> Path | None:
    """用户个人文件根目录；个人 Shell 不得把用户目录外的路径当作工作区。"""
    settings = get_settings()
    if settings.storage.backend != "local":
        return None
    root = (Path(settings.storage.local_path).resolve() / str(user_id)).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


async def resolve_shell_root(db: AsyncSession, user_id, scope: str, workspace_id: int | None) -> Path | None:
    if scope == "workspace":
        return await resolve_workspace_root(db, user_id, workspace_id) if workspace_id else None
    if scope == "personal":
        return await resolve_personal_shell_root(db, user_id)
    if scope == "system":
        return Path("/").resolve()
    return None
