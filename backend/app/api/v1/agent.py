"""AI Agent API —— 薄层。

业务逻辑已迁入独立 `agent` 包（agent/core, context, skills, profiles,
adapters）。本文件只负责：接收请求 → 构造 AgentRequest → 调 web adapter →
包成 StreamingResponse；以及对话会话的纯 CRUD 端点。
"""
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, UploadFile, File as FastAPIFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import chat_attach
from app.core.security import get_current_user, get_current_user_id, get_current_user_identity, CurrentUserIdentity
from app.core.ownership import get_owned
from app.core.tz import iso_utc
from app.db.session import get_db
from app.models import ConversationMessage, ConversationSession, User, UserBot, Workspace
from app.services import interactions
from app.services.workspaces import resolve_sandbox_root
from agent.sandbox.docker_runtime import cleanup_sandboxes_for_root
from agent.sandbox.quota import clear_sandbox_directory

from agent.llm import genstream
from agent.gateway import web as web_adapter
from agent.im.models import replace_mention_ids
from agent.models import AgentRequest
from agent.context.history import build_chat_tool_events

router = APIRouter(prefix="/agent", tags=["agent"])

_MAX_ATTACH_BYTES = 10 * 1024 * 1024   # 单个聊天附件上限 10MB


class ChatRequest(BaseModel):
    message: str
    locale: Optional[Literal["zh-CN", "ja-JP", "en-US"]] = None
    session_id: Optional[int] = None
    attachments: Optional[list[str]] = None   # 聊天附件的 attach_id 列表（来自 /agent/upload）
    references: Optional[list[dict]] = None   # 用户通过 @ 补全选中的业务对象
    greeting: Optional[str] = None            # 新会话首条消息携带的「已显示默认问候」→ 落为本会话首条 assistant 消息
    interaction_prompt_id: Optional[int] = None
    interaction_token: Optional[str] = None
    interaction_event_id: Optional[str] = None


class InteractionResponseRequest(BaseModel):
    token: str
    event_id: Optional[str] = None


class InteractionTextRequest(BaseModel):
    text: str
    event_id: Optional[str] = None


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


@router.get("/sessions/{session_id}/interactions")
async def list_session_interactions(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出会话交互历史；活动项带一次性 token，历史项只用于恢复气泡。"""
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "会话不存在")
    return {"items": await interactions.list_history(db, user_id=current_user.id, session_id=session_id)}


@router.post("/interactions/{prompt_id}/respond")
async def respond_interaction(
    prompt_id: int,
    body: InteractionResponseRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """消费一次交互动作，返回 Agent bridge 用的受控结果。"""
    try:
        result = await interactions.consume_action(
            db,
            user_id=current_user.id,
            prompt_id=prompt_id,
            token=body.token,
            event_id=body.event_id,
        )
    except LookupError:
        raise HTTPException(404, "交互不存在")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    return result


@router.post("/interactions/{prompt_id}/resume")
async def resume_interaction(
    prompt_id: int,
    body: InteractionResponseRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """消费 ask_user 回答，唤醒仍在等待中的原 Agent Run。"""
    try:
        result = await interactions.consume_action(
            db,
            user_id=current_user.id,
            prompt_id=prompt_id,
            token=body.token,
            event_id=body.event_id,
        )
    except LookupError:
        raise HTTPException(404, "交互不存在")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    if not result.get("context", {}).get("tool_call_id"):
        raise HTTPException(409, "该交互不支持恢复原任务")
    return {"ok": True, "session_id": result["session_id"]}


@router.post("/interactions/{prompt_id}/resume-text")
async def resume_text_interaction(
    prompt_id: int,
    body: InteractionTextRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """消费 ask_user 的文本回答，唤醒仍在等待中的原 Agent Run。"""
    try:
        result = await interactions.consume_text(
            db, user_id=current_user.id, prompt_id=prompt_id,
            text=body.text, event_id=body.event_id,
        )
    except LookupError:
        raise HTTPException(404, "交互不存在")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    if not result.get("context", {}).get("tool_call_id"):
        raise HTTPException(409, "该交互不支持恢复原任务")
    return {"ok": True, "session_id": result["session_id"]}


@router.post("/upload")
async def upload_attachment(
    file: UploadFile = FastAPIFile(...),
    voice: bool = Form(False),   # 网页录音传 voice=true → 渲染成语音条 + 独立 30 天存储 + 「让我听听」语气
    current_user: User = Depends(get_current_user),
):
    """聊天附件上传：暂存（不进文件库），返回 attach_id。咕咕可看内容/可保存。"""
    from app.core import media_transcode
    from app.core.config import get_settings
    from agent import providers
    data = await file.read()
    if len(data) > _MAX_ATTACH_BYTES:
        raise HTTPException(400, "文件太大（聊天附件上限 10MB）")
    parts = (file.filename or "file").rsplit(".", 1)
    name = parts[0] or "file"
    ext = parts[1] if len(parts) > 1 else ""
    # 语音录音：浏览器多录成 webm/opus（mimo 不收）→ 转成 mp3 再暂存，让 mimo 能听。
    # m4a(Safari)/ogg(Firefox) 是 mimo 原生格式、免转；缺 ffmpeg 则原样、退文字提示。
    if (ext or "").lower() not in ("mp3", "wav", "flac", "m4a", "ogg"):
        conv = media_transcode.to_provider_audio(data, ext, file.content_type,
                                                 providers.adapter_for(get_settings().ai))
        if conv is not None:
            data, ext = conv, "mp3"
    mime = "audio/mpeg" if ext == "mp3" else file.content_type
    if voice:
        dur = media_transcode.probe_duration(data, ext)
        meta = await chat_attach.stage_voice(current_user.id, name or "语音", ext, mime, data, duration=dur, platform="web")
    else:
        meta = await chat_attach.stage(current_user.id, name, ext, mime, data, platform="web")
    return {k: meta.get(k) for k in ("attach_id", "name", "ext", "size", "kind", "duration", "img_width", "img_height", "qq_face")}


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
    # QQ 表情可能是 GIF/动画 WebP；原图端点保留动画帧，普通缩略图则统一转 JPEG。
    mime = (meta.get("mime") or "").lower()
    if size == "full" and (
        meta.get("qq_face")
        or (meta.get("ext") or "").lower() in {"gif", "webp"}
        or mime in {"image/gif", "image/webp"}
    ):
        return Response(content=raw, media_type=mime or f"image/{(meta.get('ext') or 'gif').lower()}",
                        headers={"Cache-Control": "private, max-age=3600"})
    # 复用文件库的缩略图生成（JPEG 兜底版，按 size 取最大边）
    from app.services.files.previews import generate_thumb_jpeg_fallback
    jpeg = await asyncio.to_thread(generate_thumb_jpeg_fallback, raw, size)
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
    from app.services.files.previews import office_to_pdf

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
    pdf = await office_to_pdf(data, meta.get("ext", ""))
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Cache-Control": "private, max-age=300"})


@router.post("/chat")
async def chat(
    body: ChatRequest,
    request: Request,
    current_user: CurrentUserIdentity = Depends(get_current_user_identity),
):
    req = AgentRequest(
        message=body.message,
        user_id=current_user.id,
        user_name=current_user.username,
        session_id=body.session_id,
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
    return StreamingResponse(
        web_adapter.resume(session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/sessions/{session_id}/cancel")
async def cancel_stream(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """请求停止该用户会话的后台 Web 生成，取消在 Agent round/token 边界生效。"""
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "会话不存在")
    active = await genstream.is_active(session_id)
    if active:
        await genstream.request_cancel(session_id)
    return {"ok": True, "active": active}


@router.get("/sessions")
async def list_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 网页会话增长很快，不能用一个总量窗口把低频 IM 会话全部挤掉。
    # 两类会话分别保留窗口，再合并排序，保证 QQ/微信/飞书始终可见。
    web_res = await db.execute(
        select(ConversationSession, Workspace.name)
        .outerjoin(Workspace, Workspace.id == ConversationSession.workspace_id)
        .where(
            ConversationSession.user_id == current_user.id,
            or_(ConversationSession.source.is_(None), ConversationSession.source == "web"),
        )
        .order_by(desc(ConversationSession.updated_at))
        .limit(50)
    )
    im_res = await db.execute(
        select(ConversationSession, Workspace.name)
        .outerjoin(Workspace, Workspace.id == ConversationSession.workspace_id)
        .where(
            ConversationSession.user_id == current_user.id,
            ConversationSession.source.is_not(None),
            ConversationSession.source != "web",
        )
        .order_by(desc(ConversationSession.updated_at))
        .limit(50)
    )
    sessions = sorted(
        [*web_res.all(), *im_res.all()],
        key=lambda item: item[0].updated_at,
        reverse=True,
    )
    def goal_active(session: ConversationSession) -> bool:
        context = session.session_context if isinstance(session.session_context, dict) else {}
        return bool(context.get("goal_mode") and context.get("goal_text"))

    def goal_status(session: ConversationSession) -> str | None:
        context = session.session_context if isinstance(session.session_context, dict) else {}
        if not context.get("goal_text"):
            return None
        return "paused" if context.get("goal_status") == "paused" else "active"

    return [
        {
            "id": s.id,
            "title": s.title,
            "source": s.source,
            "chatType": s.chat_type,
            "workspaceName": workspace_name,
            "goalActive": goal_active(s),
            "goalStatus": goal_status(s),
            "updatedAt": iso_utc(s.updated_at),
            "createdAt": iso_utc(s.created_at),
        }
        for s, workspace_name in sessions
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


@router.get("/commands")
async def get_commands(current_user: User = Depends(get_current_user)):
    """返回聊天输入框使用的规范斜杠命令菜单。"""
    from agent.commands.help import command_menu

    return {"commands": command_menu()}


@router.get("/greeting")
async def get_greeting(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    locale: str = Query(default="zh-CN", pattern="^(zh-CN|ja-JP|en-US)$"),
):
    """对话框默认问候：咕咕据近期记忆/项目/提醒生成一句。失败/空 → text=''，前端兜底池接手。"""
    from app.core.config import get_settings
    from app.core.tz import set_ctx_tz, user_tz
    from agent import greeting
    set_ctx_tz(user_tz(current_user))
    text = await greeting.generate(db, current_user.id, get_settings(), locale=locale)
    return {"text": text}


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: int,
    limit: int = 50,
    before_id: Optional[int] = None,
    after_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")
    limit = min(max(limit, 1), 200)
    base_filters = (
        ConversationMessage.session_id == session_id,
        ConversationMessage.content_json.is_(None),  # 过滤工具中间消息（tool_use/tool_result）
        ConversationMessage.role != "summary",       # 过滤对话压缩摘要（注入 system prompt，不进对话气泡）
    )
    statement = select(ConversationMessage).where(*base_filters)
    if before_id is not None:
        statement = statement.where(ConversationMessage.id < before_id).order_by(
            desc(ConversationMessage.id)
        )
    elif after_id is not None:
        statement = statement.where(ConversationMessage.id > after_id).order_by(
            ConversationMessage.id
        )
    else:
        statement = statement.order_by(desc(ConversationMessage.id))
    statement = statement.limit(limit)
    res = await db.execute(statement)
    msgs = list(res.scalars().all())
    if before_id is None and after_id is None:
        msgs.reverse()

    has_more = False
    if msgs:
        older_probe = await db.execute(
            select(ConversationMessage.id)
            .where(*base_filters, ConversationMessage.id < msgs[0].id)
            .limit(1)
        )
        has_more = older_probe.first() is not None
    mention_names = {
        str(message.platform_user_id): message.platform_user_name
        for message in msgs
        if message.platform_user_id and message.platform_user_name
    }
    # 工具调用和结果必须先在完整会话范围内配对，再按正文窗口筛选。
    # 如果只查询窗口内的行，窗口边界正好落在 tool_call/tool_result 中间时，
    # 恢复端只能看到 tool_result，只能退化成“工具调用”，从而丢失工具名称。
    # 这里只返回当前正文窗口对应的事件，不会把旧工具气泡全部塞进虚拟列表。
    tool_filters = [
        ConversationMessage.session_id == session_id,
        ConversationMessage.content_json.is_not(None),
    ]
    tool_rows = (await db.execute(
        select(ConversationMessage).where(*tool_filters).order_by(ConversationMessage.id)
    )).scalars().all()
    tool_events = build_chat_tool_events(tool_rows)
    if msgs:
        message_ids = [message.id for message in msgs]
        first_id, last_id = min(message_ids), max(message_ids)
        tool_events = [
            event for event in tool_events
            if first_id <= int(event.get("timelineOrder") or 0) <= last_id
        ]
    else:
        tool_events = []
    # assistant timeline 可能只包含正文轮次；只有 timeline 已经包含工具项时，
    # 才抑制兼容 toolEvents，避免刷新后工具气泡消失或重复。
    timeline_has_tools = any(
        any(isinstance(item, dict) and item.get("kind") == "tool" for item in (message.display_timeline or []))
        for message in msgs
    )
    for message in msgs:
        if message.platform_bot_user_id:
            mention_names[message.platform_bot_user_id] = "咕咕"
    # 群聊消息按发言人区分左右气泡：owner 的平台身份挂在该来源的 UserBot 上
    # （目前只有 QQ 走了绑定流程，其它渠道查不到就是 None，前端据此把消息
    # 归到左侧、标发言人 username，而不是误判成 owner 自己发的）。
    owner_platform_user_id = None
    if session.source:
        bot_query = select(UserBot).where(
            UserBot.user_id == current_user.id,
            UserBot.platform == session.source,
        )
        if session.bot_id:
            bot_query = bot_query.where(UserBot.id == int(session.bot_id))
        bot = (await db.execute(bot_query)).scalars().first()
        owner_platform_user_id = bot.owner_platform_user_id if bot else None
        if bot and bot.bot_platform_user_id:
            mention_names[bot.bot_platform_user_id] = "咕咕"

    def render_content(text: str) -> str:
        if session.chat_type != "group":
            return text
        # 只替换当前会话已知的成员和 Bot ID，未知 mention 保留原样。
        return replace_mention_ids(text, mention_names)

    workspace = await get_owned(db, Workspace, session.workspace_id, current_user.id) if session.workspace_id else None
    session_context = session.session_context if isinstance(session.session_context, dict) else {}
    return {
        "session": {"id": session.id, "title": session.title, "chatType": session.chat_type,
                    "ownerPlatformUserId": owner_platform_user_id,
                    "workspaceName": workspace.name if workspace else None,
                    "goalActive": bool(session_context.get("goal_mode") and session_context.get("goal_text")),
                    "goalStatus": "paused" if session_context.get("goal_status") == "paused" and session_context.get("goal_text") else ("active" if session_context.get("goal_text") else None)},
        "active": await genstream.is_active(session_id),   # 该会话是否正在生成（前端据此续看）
        "pagination": {
            "limit": limit,
            "hasMore": has_more,
            "oldestId": msgs[0].id if msgs else None,
            "newestId": msgs[-1].id if msgs else None,
        },
        "messages": [
            {"id": m.id, "role": m.role,
             "timelineOrder": m.id * 1000,
             "content": render_content(m.content),
             "files": m.files or [],
             "references": m.references_json or [],
             "quotedText": m.quoted_text,
             "platformUserId": m.platform_user_id,
             "platformUserName": m.platform_user_name,
             "platformBotUserId": m.platform_bot_user_id,
             "createdAt": iso_utc(m.created_at)}
            for m in msgs
            if not (m.role == "assistant" and m.display_timeline)
        ],
        "timelineEvents": [
            {**item,
             "id": f"{m.id}:{index}",
             "timelineOrder": m.id * 1000 + index + 1,
             "createdAt": iso_utc(m.created_at)}
            for m in msgs
            for index, item in enumerate(m.display_timeline or [])
        ],
        "toolEvents": [
            {**event, "timelineOrder": int(event.get("timelineOrder") or 0) * 1000,
             "createdAt": iso_utc(event["createdAt"]),
             **({"updatedAt": iso_utc(event["updatedAt"])} if event.get("updatedAt") else {})}
            for event in ([] if timeline_has_tools else tool_events)
        ],
    }


@router.get("/messages/{message_id}")
async def get_message_location(
    message_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """按消息 id 反查它所在的会话——笔记里的「@对话」引用锚定的是具体一条消息（不是整个
    会话），点开时得先知道这条消息属于哪个会话才能 loadSession + 定位滚动。
    ConversationMessage 本身没有 user_id，要通过 session 判归属。"""
    row = (await db.execute(
        select(ConversationMessage, ConversationSession.user_id)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationMessage.id == message_id)
    )).first()
    if not row or row[1] != current_user.id:
        raise HTTPException(404, "消息不存在")
    m = row[0]
    return {"id": m.id, "sessionId": m.session_id}


@router.delete("/attachments", status_code=200)
async def clear_attachments(current_user: User = Depends(get_current_user)):
    """清除当前用户所有草稿态（未发送）聊天暂存附件（字节 + DB 行）。"""
    n = await chat_attach.clear_staged(current_user.id)
    return {"deleted": n}


@router.delete("/attachment/{attach_id}", status_code=200)
async def delete_draft_attachment(
    attach_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除单个草稿态（未发送）暂存附件——发送消息失败时前端调用，降低草稿孤儿
    产生速度（PRD-STORAGE-1 §2 FR-STORAGE-1-1 步骤 8）。

    **状态守卫是这个接口存在的意义**：只删 `state='draft'` 的附件，非 draft
    一律拒绝。HTTP 响应丢失/超时不等于请求真的失败——消息可能已经在服务端
    提交成功、附件已经被 claim 成 `attached`；没有这层守卫，客户端一次误判的
    "发送失败"会把已经生效的正常附件删掉。"""
    from app.models import ChatAttachment
    from sqlalchemy import delete as sa_delete, select
    row = (await db.execute(
        select(ChatAttachment).where(
            ChatAttachment.user_id == current_user.id,
            ChatAttachment.attach_id == attach_id,
        )
    )).scalars().first()
    if row is None:
        raise HTTPException(404, "附件不存在")
    storage_key = row.storage_key
    result = await db.execute(
        sa_delete(ChatAttachment).where(
            ChatAttachment.attach_id == attach_id,
            ChatAttachment.user_id == current_user.id,
            ChatAttachment.state == "draft",
        )
    )
    if result.rowcount != 1:
        await db.rollback()
        raise HTTPException(409, "附件已被使用，无法删除")
    await db.commit()
    await chat_attach.try_delete_storage_if_unreferenced(current_user.id, storage_key)
    return {"deleted": True}


@router.delete("/memory", status_code=204)
async def clear_memory(
    current_user: User = Depends(get_current_user),
):
    """清除当前用户的全部 AI 记忆——直接删掉 .agent/ 整个目录（含向量缓存等一切衍生文件），
    不再一个个列文件名：新增记忆文件时忘了加进清单会漏删，这个类别的坑一次性堵死。"""
    from agent.memory.store import _DIR
    from app.services.storage import get_storage
    from app.core import events
    storage = get_storage()
    await storage.delete_prefix(f"{current_user.id}/{_DIR}/")
    await events.bump_context_revision(current_user.id, "memory")


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删会话：DB commit 优先于 storage 删除，两阶段（PRD-STORAGE-1 不变量 1）。

    ① 一个事务内显式删除该会话下所有消息关联的 `chat_attachments` 行，再删
    session（ORM cascade 级联删 `conversation_messages`）——**不依赖 `message_id`
    外键的 `ON DELETE CASCADE` 自动帮忙**：SQLite（测试用）默认不强制外键约束，
    而 Postgres（生产）默认强制，两边行为不一致，靠应用层显式删除更可靠、也让
    这段逻辑在两种数据库下行为一致、可测试。
    ② commit 成功后，对每个涉及的 `storage_key` 走 `try_delete_storage_if_unreferenced()`
    尽力删物理字节，失败只记日志不阻塞、不回滚，留给安全网兜底（PRD-STORAGE-1
    不变量 2：删除前必须确认没有其他存活行还引用同一个 storage_key，对应 PRD-IM-9
    的共享附件场景）。"""
    from app.services.conversation_cleanup import remove_session_with_attachments
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")
    await remove_session_with_attachments(db, session)


class RenameSessionRequest(BaseModel):
    title: str


@router.patch("/sessions/{session_id}")
async def rename_session(
    session_id: int,
    body: RenameSessionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """重命名会话标题，方便用户区分不同对话。

    P1-3：手动改名后置 ``title_locked=True``，永久禁止自动标题任务覆盖。后续
    ``_gen_title_bg`` 在写 title 前会查这个标志，是 True 直接跳过——手动改名
    一劳永逸地赢下与异步自动标题生成的竞态。
    """
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(422, "标题不能为空")
    if len(title) > 300:
        raise HTTPException(422, "标题过长")
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")
    session.title = title
    session.title_locked = True   # P1-3：手动改名后禁止自动标题覆盖
    await db.commit()
    return {"id": session.id, "title": session.title, "title_locked": session.title_locked}


@router.post("/sessions/{session_id}/refresh-context")
async def refresh_session_context(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """显式让下一轮重新读取一次 session snapshot。"""
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")
    from agent.context.session_snapshot import invalidate_snapshot
    invalidate_snapshot(session)
    await db.commit()
    return {"id": session.id, "context_epoch": session.context_epoch, "refresh_scheduled": True}
