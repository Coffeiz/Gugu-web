"""AI Agent API —— 薄层。

业务逻辑已迁入独立 `agent` 包（agent/core, context, skills, profiles,
adapters）。本文件只负责：接收请求 → 构造 AgentRequest → 调 web adapter →
包成 StreamingResponse；以及对话会话的纯 CRUD 端点。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import ConversationMessage, ConversationSession, User

from agent.adapters import web as web_adapter
from agent.models import AgentRequest

router = APIRouter(prefix="/agent", tags=["agent"])


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None


@router.post("/chat")
async def chat(
    body: ChatRequest,
    current_user: User = Depends(get_current_user),
):
    req = AgentRequest(
        message=body.message,
        user_id=current_user.id,
        user_name=current_user.username,
        session_id=body.session_id,
        source="web",
    )
    return StreamingResponse(
        web_adapter.stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/sessions")
async def list_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(
        select(ConversationSession)
        .where(ConversationSession.user_id == current_user.id)
        .order_by(desc(ConversationSession.updated_at))
        .limit(50)
    )
    sessions = res.scalars().all()
    return [
        {
            "id": s.id,
            "title": s.title,
            "source": s.source,
            "updatedAt": s.updated_at.isoformat(),
            "createdAt": s.created_at.isoformat(),
        }
        for s in sessions
    ]


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(ConversationSession, session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(404, "对话不存在")
    res = await db.execute(
        select(ConversationMessage)
        .where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.content_json.is_(None),  # 过滤工具中间消息（tool_use/tool_result）
        )
        .order_by(ConversationMessage.created_at)
    )
    msgs = res.scalars().all()
    return {
        "session": {"id": session.id, "title": session.title},
        "messages": [
            {"role": m.role, "content": m.content, "files": m.files or [],
             "createdAt": m.created_at.isoformat()}
            for m in msgs
        ],
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(ConversationSession, session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(404, "对话不存在")
    await db.delete(session)
    await db.commit()
