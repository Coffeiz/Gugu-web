"""Agent API chat endpoints."""

from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agent.gateway import web as web_adapter
from agent.llm import genstream
from agent.models import AgentRequest
from app.core.ownership import get_owned
from app.core.security import get_current_user, get_current_user_id, get_current_user_identity, CurrentUserIdentity
from app.db.session import get_db
from app.models import ConversationSession, User

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    client_message_id: Optional[str] = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9:_-]+$")
    locale: Optional[Literal["zh-CN", "ja-JP", "en-US"]] = None
    session_id: Optional[int] = None
    pending_queue_id: Optional[str] = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    pending_queue_item_key: Optional[int] = Field(default=None, gt=0)
    pending_queue_claim_token: Optional[str] = Field(default=None, max_length=128)
    attachments: Optional[list[str]] = None   # 聊天附件的 attach_id 列表（来自 /agent/upload）
    references: Optional[list[dict]] = None   # 用户通过 @ 补全选中的业务对象
    greeting: Optional[str] = None            # 新会话首条消息携带的「已显示默认问候」→ 落为本会话首条 assistant 消息
    interaction_prompt_id: Optional[int] = None
    interaction_token: Optional[str] = None
    interaction_event_id: Optional[str] = None

@router.post("/chat")
async def chat(
    body: ChatRequest,
    request: Request,
    current_user: CurrentUserIdentity = Depends(get_current_user_identity),
):
    req = AgentRequest(
        message=body.message,
        client_message_id=body.client_message_id,
        user_id=current_user.id,
        user_name=current_user.username,
        session_id=body.session_id,
        pending_queue_id=body.pending_queue_id,
        pending_queue_item_key=body.pending_queue_item_key,
        pending_queue_claim_token=body.pending_queue_claim_token,
        source="web",
        attachments=body.attachments or [],
        references=body.references or [],
        greeting=body.greeting,
        locale=body.locale,
        origin=request.headers.get("X-Client-Id"),
        interaction_prompt_id=body.interaction_prompt_id,
        interaction_token=body.interaction_token,
        interaction_event_id=body.interaction_event_id,
    )
    return StreamingResponse(
        web_adapter.stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@router.get("/sessions/{session_id}/stream")
async def resume_stream(
    session_id: int,
    user_id: UUID = Depends(get_current_user_id),
):
    """续看进行中的生成（刷新后重连）。无进行中的生成则立即返回 idle done。"""
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        session = await get_owned(db, ConversationSession, session_id, user_id)
    if not session:
        raise HTTPException(404, "对话不存在")
    from agent.context.compress_conv import recover_orphaned_session
    await recover_orphaned_session(session_id, user_id=user_id)
    return StreamingResponse(
        web_adapter.resume(session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@router.get("/sessions/{session_id}/state")
async def get_session_state(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """会话执行状态的轻量快照，供前端在基线整理期间轮询收尾提示。"""
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")
    from agent.context.compress_conv import recover_orphaned_session
    await recover_orphaned_session(session_id, user_id=current_user.id)
    await db.refresh(session)
    return {
        "executionState": session.execution_state,
        "pendingMessageCount": int(session.pending_message_count or 0),
        "active": await genstream.is_active(session_id),
    }

@router.post("/sessions/{session_id}/cancel")
async def cancel_stream(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """终止该用户会话的后台 Web 生成。

    三条路径按序兜底：先回收重启遗留的僵尸状态；同进程内登记的生成任务按
    快照 owner_run_id 精确 cancel（立即生效）；跨 worker / 任务未登记时退回
    Redis 取消标记，由 run 心跳在 5s 内自取消。
    """
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "会话不存在")
    from agent.context.compress_conv import recover_orphaned_session
    recovered = await recover_orphaned_session(session_id, user_id=current_user.id)
    active = await genstream.is_active(session_id)
    cancelled_locally = False
    if active:
        # 排队引入后同一会话可能有多个后台任务（一个在跑、其余在门上排队）。
        # 必须按快照的 owner_run_id 精确取消「正在跑的这个」，否则会杀掉排队
        # 任务而真正在跑的 run 继续；本进程没有该任务时回退取消标记（跨 worker）。
        snap = await genstream.snapshot(session_id)
        owner_run_id = str((snap or {}).get("owner_run_id") or "")
        from agent.gateway.web import cancel_local_generation
        cancelled_locally = cancel_local_generation(session_id, owner_run_id or None)
        if not cancelled_locally:
            # 标记带上快照 owner：跨 worker 兜底也只能杀掉用户看到正在跑的
            # 这个 run。终止端点读快照与写标记之间，排队的 run 可能已经接管
            # 会话（begin 清不掉这之后才落下的标记），会话级标记会把刚接管的
            # 排队消息一起杀掉——用户消息已落库但永远等不到回复。
            from agent.runtime.cancellation import request_cancel
            await request_cancel(session_id=session_id, owner_run_id=owner_run_id or None)
    return {
        "ok": True,
        "active": active,
        "recovered": recovered,
        "cancelled_locally": cancelled_locally,
        "outcome": "requested" if active else ("interrupted" if recovered else "already_completed"),
    }
