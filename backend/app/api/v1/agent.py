"""AI Agent API —— 薄层。

业务逻辑已迁入独立 `agent` 包（agent/core, context, skills, profiles,
adapters）。本文件只负责：接收请求 → 构造 AgentRequest → 调 web adapter →
包成 StreamingResponse；以及对话会话的纯 CRUD 端点。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File as FastAPIFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import chat_attach
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import ConversationMessage, ConversationSession, User

from agent import genstream
from agent.adapters import web as web_adapter
from agent.models import AgentRequest

router = APIRouter(prefix="/agent", tags=["agent"])

_MAX_ATTACH_BYTES = 10 * 1024 * 1024   # 单个聊天附件上限 10MB


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None
    attachments: Optional[list[str]] = None   # 聊天附件的 attach_id 列表（来自 /agent/upload）


@router.post("/upload")
async def upload_attachment(
    file: UploadFile = FastAPIFile(...),
    current_user: User = Depends(get_current_user),
):
    """聊天附件上传：暂存（不进文件库），返回 attach_id。咕咕可看内容/可保存。"""
    data = await file.read()
    if len(data) > _MAX_ATTACH_BYTES:
        raise HTTPException(400, "文件太大（聊天附件上限 10MB）")
    parts = (file.filename or "file").rsplit(".", 1)
    name = parts[0] or "file"
    ext = parts[1] if len(parts) > 1 else ""
    meta = await chat_attach.stage(current_user.id, name, ext, file.content_type, data)
    return {k: meta[k] for k in ("attach_id", "name", "ext", "size", "kind")}


@router.get("/attachment/{attach_id}/thumb")
async def attachment_thumb(
    attach_id: str,
    size: str = "card",
    current_user: User = Depends(get_current_user),
):
    """暂存聊天附件的图片缩略图（按 attach_id）。
    刷新后历史气泡里用户发的图本来只有 attach_id（无 file_id、本地 objectURL 已丢），
    借此仍能显示缩略图。仅暂存 6h 内有效，过期/非图片 → 404，前端回退到 ext 角标。"""
    import asyncio
    from fastapi.responses import Response

    meta = await chat_attach.get_meta(current_user.id, attach_id)
    if not meta or meta.get("kind") != "image":
        raise HTTPException(404, "附件不存在或不是图片")
    try:
        raw = await chat_attach.read_bytes(meta)
    except FileNotFoundError:
        raise HTTPException(404, "附件已过期或物理文件丢失")
    if (meta.get("ext") or "").lower() == "svg":
        return Response(content=raw, media_type="image/svg+xml",
                        headers={"Cache-Control": "private, max-age=3600"})
    # 复用文件库的缩略图生成（JPEG 兜底版，按 size 取最大边）
    from app.api.v1.files import _generate_thumb_jpeg_fallback
    jpeg = await asyncio.to_thread(_generate_thumb_jpeg_fallback, raw, size)
    if jpeg:
        return Response(content=jpeg, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})
    return Response(content=raw, media_type=meta.get("mime") or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600"})


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
        attachments=body.attachments or [],
    )
    return StreamingResponse(
        web_adapter.stream(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/sessions/{session_id}/stream")
async def resume_stream(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """续看进行中的生成（刷新后重连）。无进行中的生成则立即返回 idle done。"""
    session = await db.get(ConversationSession, session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(404, "对话不存在")
    return StreamingResponse(
        web_adapter.resume(session_id),
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
        "active": await genstream.is_active(session_id),   # 该会话是否正在生成（前端据此续看）
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
