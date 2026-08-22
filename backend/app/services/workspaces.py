"""工作区归属与会话绑定服务。

这里只负责声明、归属和绑定；Shell 执行器及沙盒留在后续阶段，避免把未授权能力
通过工作区表间接打开。
"""
from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationSession, Folder, Project, UserPreferences, Workspace
from app.core.ownership import get_owned


async def get_workspace(db: AsyncSession, user_id, workspace_id: int) -> Workspace | None:
    return await get_owned(db, Workspace, workspace_id, user_id)


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


async def describe_session(db: AsyncSession, user_id, session_id: int) -> Workspace | None:
    session = await get_owned(db, ConversationSession, session_id, user_id)
    if session is None or session.workspace_id is None:
        return None
    return await get_workspace(db, user_id, session.workspace_id)
