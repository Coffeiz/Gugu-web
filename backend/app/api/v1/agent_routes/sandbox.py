"""Agent API sandbox endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from agent.sandbox.docker_runtime import cleanup_sandboxes_for_root
from agent.sandbox.quota import clear_sandbox_directory
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User
from app.services.workspaces import resolve_sandbox_root

router = APIRouter()


class SandboxClearRequest(BaseModel):
    confirm_text: str = ""

@router.post("/sandbox/restart")
async def restart_my_sandbox(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    root = await resolve_sandbox_root(db, current_user.id)
    if root is None:
        raise HTTPException(409, "当前存储后端没有可用的 Shell 沙盒目录")
    return {"ok": True, "operation": "restart", "reclaimed_containers": cleanup_sandboxes_for_root(str(root))}

@router.post("/sandbox/rebuild")
async def rebuild_my_sandbox(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    root = await resolve_sandbox_root(db, current_user.id)
    if root is None:
        raise HTTPException(409, "当前存储后端没有可用的 Shell 沙盒目录")
    reclaimed = cleanup_sandboxes_for_root(str(root))
    return {"ok": True, "operation": "rebuild", "root_ready": root.is_dir(), "reclaimed_containers": reclaimed}

@router.post("/sandbox/clear")
async def clear_my_sandbox(
    body: SandboxClearRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.confirm_text != "清空沙盒":
        raise HTTPException(409, "清空沙盒需要输入确认文字：清空沙盒")
    root = await resolve_sandbox_root(db, current_user.id)
    if root is None:
        raise HTTPException(409, "当前存储后端没有可用的 Shell 沙盒目录")
    reclaimed = cleanup_sandboxes_for_root(str(root))
    removed = clear_sandbox_directory(root)
    return {"ok": True, "operation": "clear", "removed_entries": removed, "reclaimed_containers": reclaimed}
