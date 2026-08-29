"""工作区与会话绑定 API（Phase 0-2）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import ConversationSession, User, Workspace
from app.schemas import WorkspaceCreate, WorkspaceResponse, WorkspaceUpdate
from app.services.workspaces import (
    bind_session,
    create_workspace,
    effective_shell_dangerous_enabled,
    effective_shell_enabled,
    effective_shell_autopilot_enabled,
    effective_shell_system_enabled,
    get_workspace,
    delete_workspace,
    update_workspace,
)

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


def _response(row: Workspace, count: int = 0) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=row.id, name=row.name, kind=row.kind, folderId=row.folder_id,
        projectId=row.project_id, enabled=row.enabled, isDefault=row.is_default,
        boundSessionCount=count,
    )


@router.get("")
async def list_workspaces(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(Workspace).where(Workspace.user_id == user.id).order_by(Workspace.updated_at.desc())
    )).scalars().all()
    counts = dict((await db.execute(
        select(ConversationSession.workspace_id, func.count(ConversationSession.id))
        .where(ConversationSession.user_id == user.id, ConversationSession.workspace_id.is_not(None))
        .group_by(ConversationSession.workspace_id)
    )).all())
    return {
        "globalEnabled": bool(get_settings().agent.shell_enabled),
        "systemGlobalEnabled": bool(get_settings().agent.shell_system_enabled),
        "dangerousGlobalEnabled": bool(get_settings().agent.shell_dangerous_enabled),
        "autopilotGlobalEnabled": bool(get_settings().agent.shell_autopilot_enabled),
        "userEnabled": await effective_shell_enabled(db, user.id),
        "userSystemEnabled": await effective_shell_system_enabled(db, user.id),
        "userDangerousEnabled": await effective_shell_dangerous_enabled(db, user.id),
        "userAutopilotEnabled": await effective_shell_autopilot_enabled(db, user.id),
        "items": [_response(row, counts.get(row.id, 0)) for row in rows],
    }


@router.post("", response_model=WorkspaceResponse)
async def add_workspace(
    body: WorkspaceCreate,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    try:
        row = await create_workspace(
            db, user.id, name=body.name, kind=body.kind,
            folder_id=body.folderId, project_id=body.projectId, enabled=body.enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    return _response(row)


@router.patch("/{workspace_id}", response_model=WorkspaceResponse)
async def edit_workspace(
    workspace_id: int, body: WorkspaceUpdate,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    try:
        row = await update_workspace(
            db, user.id, workspace_id, name=body.name, enabled=body.enabled,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    count = (await db.execute(
        select(func.count(ConversationSession.id)).where(
            ConversationSession.user_id == user.id,
            ConversationSession.workspace_id == workspace_id,
        )
    )).scalar_one()
    await db.commit()
    return _response(row, count)


@router.delete("/{workspace_id}")
async def remove_workspace(
    workspace_id: int,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    try:
        await delete_workspace(db, user.id, workspace_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await db.commit()
    return {"ok": True, "workspaceId": workspace_id}


@router.post("/{workspace_id}/bind/{session_id}", response_model=WorkspaceResponse)
async def bind_workspace(
    workspace_id: int, session_id: int,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    try:
        await bind_session(db, user.id, session_id, workspace_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    row = await get_workspace(db, user.id, workspace_id)
    await db.commit()
    return _response(row, 1)


@router.delete("/binding/{session_id}")
async def unbind_workspace(
    session_id: int,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    try:
        await bind_session(db, user.id, session_id, None)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await db.commit()
    return {"ok": True, "sessionId": session_id, "workspaceId": None}


@router.get("/session/{session_id}")
async def current_workspace(
    session_id: int,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(
        select(ConversationSession).where(
            ConversationSession.id == session_id,
            ConversationSession.user_id == user.id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    workspace = await get_workspace(db, user.id, row.workspace_id) if row.workspace_id else None
    return {"sessionId": session_id, "workspace": _response(workspace) if workspace else None}
