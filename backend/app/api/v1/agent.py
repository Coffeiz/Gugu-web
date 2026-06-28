"""AI Agent API —— 薄层。

业务逻辑已迁入独立 `agent` 包（agent/core, context, skills, profiles,
adapters）。本文件只负责：接收请求 → 构造 AgentRequest → 调 web adapter →
包成 StreamingResponse；以及对话会话的纯 CRUD 端点。
"""
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File as FastAPIFile
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
    greeting: Optional[str] = None            # 新会话首条消息携带的「已显示默认问候」→ 落为本会话首条 assistant 消息


@router.post("/upload")
async def upload_attachment(
    file: UploadFile = FastAPIFile(...),
    voice: bool = Form(False),   # 网页录音传 voice=true → 渲染成语音条 + 独立 30 天存储 + 「让我听听」语气
    current_user: User = Depends(get_current_user),
):
    """聊天附件上传：暂存（不进文件库），返回 attach_id。咕咕可看内容/可保存。"""
    from app.core import media_transcode
    data = await file.read()
    if len(data) > _MAX_ATTACH_BYTES:
        raise HTTPException(400, "文件太大（聊天附件上限 10MB）")
    parts = (file.filename or "file").rsplit(".", 1)
    name = parts[0] or "file"
    ext = parts[1] if len(parts) > 1 else ""
    # 语音录音：浏览器多录成 webm/opus（mimo 不收）→ 转成 mp3 再暂存，让 mimo 能听。
    # m4a(Safari)/ogg(Firefox) 是 mimo 原生格式、免转；缺 ffmpeg 则原样、退文字提示。
    if (ext or "").lower() not in ("mp3", "wav", "flac", "m4a", "ogg"):
        conv = media_transcode.to_mimo_mp3(data, ext, file.content_type)
        if conv is not None:
            data, ext = conv, "mp3"
    mime = "audio/mpeg" if ext == "mp3" else file.content_type
    if voice:
        dur = media_transcode.probe_duration(data, ext)
        meta = await chat_attach.stage_voice(current_user.id, name or "语音", ext, mime, data, duration=dur)
    else:
        meta = await chat_attach.stage(current_user.id, name, ext, mime, data)
    return {k: meta.get(k) for k in ("attach_id", "name", "ext", "size", "kind", "duration")}


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


@router.get("/attachment/{attach_id}/download")
async def attachment_download(
    attach_id: str,
    current_user: User = Depends(get_current_user),
):
    """下载暂存聊天附件原文件（用户自己发的附件，6h 内有效）。"""
    from fastapi.responses import Response
    from urllib.parse import quote
    meta = await chat_attach.get_meta(current_user.id, attach_id)
    if not meta:
        raise HTTPException(404, "附件不存在或已过期")
    try:
        data = await chat_attach.read_bytes(meta)
    except FileNotFoundError:
        raise HTTPException(404, "附件已过期或物理文件丢失")
    filename = f"{meta.get('name', 'file')}.{meta.get('ext', '')}"
    encoded = quote(filename)
    return Response(
        content=data,
        media_type=meta.get("mime") or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"},
    )


@router.get("/attachment/{attach_id}/preview-pdf")
async def attachment_preview_pdf(
    attach_id: str,
    current_user: User = Depends(get_current_user),
):
    """将聊天暂存附件（Office 格式）转换为 PDF 供前端预览。"""
    from fastapi.responses import Response
    from app.api.v1.files import _office_to_pdf

    meta = await chat_attach.get_meta(current_user.id, attach_id)
    if not meta:
        raise HTTPException(404, "附件不存在或已过期")
    ext = (meta.get("ext") or "").upper()
    if ext not in {"DOC", "DOCX", "XLS", "XLSX", "PPT", "PPTX"}:
        raise HTTPException(400, "不支持的格式")
    try:
        data = await chat_attach.read_bytes(meta)
    except FileNotFoundError:
        raise HTTPException(404, "附件已过期或物理文件丢失")
    pdf = await _office_to_pdf(data, meta.get("ext", ""))
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Cache-Control": "private, max-age=300"})


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
        greeting=body.greeting,
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


@router.get("/ui-labels")
async def get_ui_labels(current_user: User = Depends(get_current_user)):
    """聊天前端用的「状态显示名」——目前只有「思考中」三个点的文字是前端态（无 SSE 事件），
    工具名/复查前缀都由后端在 tool_call 事件里直接下发。返回解析后的特殊状态名（已套用后台覆盖）。"""
    import re
    from app.core.config import get_settings
    from agent.core import SPECIAL_STATE_LABELS
    ov = getattr(getattr(get_settings(), "state_labels", None), "overrides", None) or {}
    merged = {**SPECIAL_STATE_LABELS, **{k: v for k, v in ov.items() if k.startswith("_") and v}}

    def _split(raw: str) -> list[str]:
        # 命名可含多个候选（| 或换行分隔）→ 返回数组，前端每次随机取一个
        return [p.strip() for p in re.split(r"[|\n]", raw or "") if p.strip()]

    return {"thinking": _split(merged.get("_thinking", ""))}


@router.get("/greeting")
async def get_greeting(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """对话框默认问候：咕咕据近期记忆/项目/提醒生成一句。失败/空 → text=''，前端兜底池接手。"""
    from app.core.config import get_settings
    from agent import greeting
    return {"text": await greeting.generate(db, current_user.id, get_settings())}


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
            ConversationMessage.role != "summary",       # 过滤对话压缩摘要（注入 system prompt，不进对话气泡）
        )
        .order_by(ConversationMessage.created_at)
    )
    msgs = res.scalars().all()
    return {
        "session": {"id": session.id, "title": session.title},
        "active": await genstream.is_active(session_id),   # 该会话是否正在生成（前端据此续看）
        "messages": [
            {"id": m.id, "role": m.role, "content": m.content, "files": m.files or [],
             "createdAt": m.created_at.isoformat()}
            for m in msgs
        ],
    }


@router.delete("/memory", status_code=204)
async def clear_memory(
    current_user: User = Depends(get_current_user),
):
    """清除当前用户的全部 AI 记忆（facts / daily / memory）。"""
    from agent.memory.store import _key, _DIR
    from app.services.storage import get_storage
    storage = get_storage()
    for name in ("facts.md", "daily.md", "memory.md", "summary.md"):
        try:
            await storage.delete(_key(current_user.id, name))
        except Exception:
            pass


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
