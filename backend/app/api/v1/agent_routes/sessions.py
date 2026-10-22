"""Agent API sessions endpoints."""

import json
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import Text, and_, case, cast, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer, load_only

from agent.context.display_timeline import merge_tool_timeline_items
from agent.context.history import build_chat_tool_events
from agent.im.models import replace_mention_ids
from agent.llm import genstream
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.core.tz import iso_utc, now_utc
from app.db.session import get_db
from app.models import ConversationMessage, ConversationSession, FilesystemAuthorizationGrant, User, UserBot, Workspace  # orm-exempt: Agent 会话域遗留查询，待 Service 收口时迁移
from app.services import conversation_pending_queue
from app.services.filesystem_authorization import SUBJECT_SESSION, filesystem_authorization_enabled, get_active_grant
from app.services.workspaces import workspace_shell_supported

router = APIRouter()


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

    from app.services.filesystem_authorization import filesystem_authorization_enabled
    filesystem_auth_enabled = filesystem_authorization_enabled()
    authorized_session_ids: set[int] = set()
    if filesystem_auth_enabled:
        active_grants = await db.scalars(
            select(FilesystemAuthorizationGrant.subject_id).where(
                FilesystemAuthorizationGrant.user_id == current_user.id,
                FilesystemAuthorizationGrant.subject_type == "session",
                FilesystemAuthorizationGrant.revoked_at.is_(None),
                or_(
                    FilesystemAuthorizationGrant.expires_at.is_(None),
                    FilesystemAuthorizationGrant.expires_at > now_utc(),
                ),
            )
        )
        authorized_session_ids = {
            int(subject_id) for subject_id in active_grants
            if str(subject_id).isdigit()
        }

    return [
        {
            "id": s.id,
            "title": s.title,
            "source": s.source,
            "chatType": s.chat_type,
            "workspaceName": workspace_name if workspace_shell_supported() else None,
            "goalActive": goal_active(s),
            "goalStatus": goal_status(s),
            "filesystemAuthorized": filesystem_auth_enabled and s.id in authorized_session_ids,
            "filesystemAuthorizationEnabled": filesystem_auth_enabled,
            "updatedAt": iso_utc(s.updated_at),
            "createdAt": iso_utc(s.created_at),
        }
        for s, workspace_name in sessions
    ]

class SessionFilesystemAuthorizationConfirm(BaseModel):
    confirm_code: str = Field(min_length=1, max_length=128)

def _session_authorization_summary(session: ConversationSession) -> str:
    return f"允许会话「{session.title or '当前会话'}」读写整个用户沙箱（包含 /workspace、/personal、/project）"

@router.post("/sessions/{session_id}/filesystem-authorization/request")
async def request_session_filesystem_authorization(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """为网页会话申请一次性确认码；申请本身不授予文件系统权限。"""
    from agent.security import confirm
    from agent.interactions.confirmations import revoke_confirmation
    from app.services.filesystem_authorization import (
        SUBJECT_SESSION, filesystem_authorization_enabled,
        record_filesystem_authorization_request,
    )

    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "会话不存在")
    if not filesystem_authorization_enabled():
        raise HTTPException(409, "完整用户沙箱授权功能当前未开启")
    if getattr(session, "filesystem_authorization_grant_id", None) is not None:
        return {"status": "authorized", "session_id": session.id}
    # 兼容旧版本：数据库授权已撤销时，清掉可能遗留的 Redis 确认授权，避免
    # 再次申请被误判为已确认而不弹窗。
    revoke_confirmation(
        current_user.id,
        _session_authorization_summary(session),
        identity=f"session:filesystem:{session.id}",
    )
    pending = confirm.needs_confirmation(
        {}, _session_authorization_summary(session), current_user.id,
        identity=f"session:filesystem:{session.id}", ttl_minutes=10,
        instruction="确认后，该会话中的 Shell 每次运行都可读写用户沙箱；不包含宿主机目录。",
        purpose=confirm.AUTHORIZATION,
    )
    if pending is None:
        return {"status": "authorized", "session_id": session.id}
    try:
        response = json.loads(pending)
    except (TypeError, ValueError):
        raise HTTPException(503, "确认服务暂不可用，请稍后重试") from None
    record_filesystem_authorization_request(
        db, user_id=current_user.id, subject_type=SUBJECT_SESSION,
        subject_id=session.id, source="user",
    )
    await db.commit()
    return response

@router.post("/sessions/{session_id}/filesystem-authorization")
async def confirm_session_filesystem_authorization(
    session_id: int,
    body: SessionFilesystemAuthorizationConfirm,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """兑换确认码并创建当前会话级授权。"""
    from agent.interactions.confirmations import redeem_confirmation
    from agent.security import confirm
    from app.services.filesystem_authorization import (
        filesystem_authorization_enabled, grant_session_filesystem_access,
    )

    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "会话不存在")
    if not filesystem_authorization_enabled():
        raise HTTPException(409, "完整用户沙箱授权功能当前未开启")
    if redeem_confirmation(current_user.id, body.confirm_code) is None:
        raise HTTPException(400, "授权确认已失效，请重新确认")
    pending = confirm.needs_confirmation(
        {}, _session_authorization_summary(session), current_user.id,
        identity=f"session:filesystem:{session.id}", ttl_minutes=10,
        purpose=confirm.AUTHORIZATION,
    )
    if pending is not None:
        raise HTTPException(400, "授权确认不匹配，请重新确认")
    try:
        grant = await grant_session_filesystem_access(db, current_user.id, session.id)
    except LookupError as exc:
        raise HTTPException(409, str(exc)) from exc
    await db.commit()
    return {"status": "authorized", "session_id": session.id, "grant_id": grant.id}

@router.delete("/sessions/{session_id}/filesystem-authorization")
async def revoke_session_filesystem_authorization(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """撤销当前会话级完整用户沙箱权限。"""
    from app.services.filesystem_authorization import revoke_session_filesystem_access

    try:
        revoked = await revoke_session_filesystem_access(db, current_user.id, session_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    await db.commit()
    return {"status": "revoked", "session_id": session_id, "revoked": revoked}

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
    # 兼容旧展示时间线：媒体块只用于模型输入，不随聊天气泡历史重复传输。
    from agent.media.images import strip_image_for_history

    # 刷新/重新进入会话时顺便收口 worker 重启留下的 running 状态，避免
    # 前端后续发送继续被旧 run 的持久化状态阻塞。
    from agent.context.compress_conv import recover_orphaned_session
    await recover_orphaned_session(session_id, user_id=current_user.id)
    limit = min(max(limit, 1), 200)
    # 分页游标覆盖消息正文和工具记录组成的统一时间线。此前只按正文消息分页，
    # 再读取整个会话的工具记录；工具密集的会话首屏仍会传输完整工具时间线。
    row_filters = (
        ConversationMessage.session_id == session_id,
        ConversationMessage.role != "summary",  # 摘要注入 system prompt，不进入聊天时间线
    )
    # 历史上 display_timeline 可能含视频帧 Base64。先延迟这个列，再用数据库侧
    # 尺寸门槛投影正常时间线；超大旧记录走正文消息回退，避免把百 MB JSON 拉进
    # Python 后才清理媒体。新写入路径已在持久化前清理媒体块。
    statement = select(ConversationMessage).options(
        defer(ConversationMessage.display_timeline),
    ).where(*row_filters)
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
    page_rows = list(res.scalars().all())
    # 所有方向都返回时间正序，分页游标覆盖本页实际读取的所有记录。
    if before_id is not None or after_id is None:
        page_rows.reverse()

    # 工具中间记录参与分页游标，但沿用既有展示契约：只有正文行和 display_timeline
    # 会作为普通消息/时间线消息返回。
    msgs = [message for message in page_rows if message.content_json is None]

    display_timeline_by_id: dict[int, list | None] = {}
    oversized_timeline_ids: set[int] = set()
    message_ids = [message.id for message in msgs]
    if message_ids:
        timeline_column = ConversationMessage.display_timeline
        if db.get_bind().dialect.name == "postgresql":
            stored_size = func.pg_column_size(timeline_column)
        else:
            stored_size = func.length(cast(timeline_column, Text))
        timeline_projection = case(
            (stored_size > 1024 * 1024, None),
            else_=timeline_column,
        )
        timeline_rows = (await db.execute(
            select(
                ConversationMessage.id,
                timeline_projection.label("display_timeline"),
                timeline_column.is_not(None).label("has_display_timeline"),
            ).where(ConversationMessage.id.in_(message_ids))
        )).all()
        for row in timeline_rows:
            display_timeline_by_id[row.id] = row.display_timeline
            if row.has_display_timeline and row.display_timeline is None:
                oversized_timeline_ids.add(row.id)

    has_more = False
    has_newer = False
    if page_rows:
        older_probe = await db.execute(
            select(ConversationMessage.id)
            .where(*row_filters, ConversationMessage.id < page_rows[0].id)
            .limit(1)
        )
        has_more = older_probe.first() is not None
        if after_id is not None and len(page_rows) == limit:
            newer_probe = await db.execute(
                select(ConversationMessage.id)
                .where(*row_filters, ConversationMessage.id > page_rows[-1].id)
                .limit(1)
            )
            has_newer = newer_probe.first() is not None
    mention_names = {
        str(message.platform_user_id): message.platform_user_name
        for message in msgs
        if message.platform_user_id and message.platform_user_name
    }
    # 同一 run/round 中补齐窗口内工具记录的配对另一端，避免窗口边界刚好拆开
    # tool_call/tool_result 时丢失工具名称；不再扫描整个会话的工具正文。
    page_tool_rows = [row for row in page_rows if row.content_json is not None]
    run_rounds = {
        (str(row.run_id), str(row.round_id))
        for row in page_tool_rows
        if row.run_id and row.round_id
    }
    tool_rows = list(page_tool_rows)
    if run_rounds:
        companion_filters = [
            and_(ConversationMessage.run_id == run_id, ConversationMessage.round_id == round_id)
            for run_id, round_id in run_rounds
        ]
        companions = (await db.execute(
            select(ConversationMessage).options(load_only(
                ConversationMessage.id,
                ConversationMessage.session_id,
                ConversationMessage.content_json,
                ConversationMessage.run_id,
                ConversationMessage.round_id,
                ConversationMessage.canonical_batch_id,
                ConversationMessage.created_at,
            )).where(
                ConversationMessage.session_id == session_id,
                ConversationMessage.content_json.is_not(None),
                or_(*companion_filters),
            ).order_by(ConversationMessage.id)
        )).scalars().all()
        seen_tool_ids = {row.id for row in tool_rows}
        tool_rows.extend(row for row in companions if row.id not in seen_tool_ids)
        tool_rows.sort(key=lambda row: row.id)
    tool_events = build_chat_tool_events(tool_rows)
    page_tool_ids = {row.id for row in page_tool_rows}
    tool_events = [event for event in tool_events if int(event.get("timelineOrder") or 0) in page_tool_ids]
    tool_events = [strip_image_for_history(event) for event in tool_events]
    # 仅抑制已由 display_timeline 展示的同一工具调用，避免一条 timeline 工具
    # 把本页其它 canonical 工具事件一并隐藏。
    timeline_tool_keys = {
        (str(item.get("runId") or ""), str(item.get("roundId") or ""), str(item.get("toolCallId") or ""))
        for message in msgs
        for item in (display_timeline_by_id.get(message.id) or [])
        if isinstance(item, dict) and item.get("kind") == "tool" and item.get("toolCallId")
    }
    tool_events = [
        event for event in tool_events
        if (str(event.get("runId") or ""), str(event.get("roundId") or ""), str(event.get("toolCallId") or "")) not in timeline_tool_keys
    ]
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

    def timeline_items(message: ConversationMessage) -> list[dict]:
        """兼容旧消息：把未写入时间线的 assistant 附件补成展示事件。"""
        # 用户附件由 messages 展示；没有时间线的助手消息也保留在 messages。
        # 只有已转入时间线的助手行需要补附件，否则会生成虚假的助手回声。
        display_timeline = display_timeline_by_id.get(message.id)
        if message.role != "assistant" or not display_timeline:
            return []
        items = merge_tool_timeline_items(display_timeline)
        if message.files and not any(
            isinstance(item, dict) and item.get("files") for item in items
        ):
            items.append({"kind": "assistant", "text": "", "files": message.files})
        return items

    def serialize_tool_event(event: dict) -> dict:
        can_load_details = bool(event.get("runId") and event.get("roundId") and event.get("toolCallId"))
        payload = {
            key: value for key, value in event.items()
            if not (can_load_details and key in {"toolInput", "toolResult"})
        }
        if can_load_details:
            payload["detailsAvailable"] = "toolInput" in event or "toolResult" in event
            payload["detailSource"] = {
                "kind": "canonical",
                "runId": event["runId"],
                "roundId": event["roundId"],
                "toolCallId": event["toolCallId"],
            }
        payload["timelineOrder"] = int(event.get("timelineOrder") or 0) * 1000
        payload["createdAt"] = iso_utc(event["createdAt"])
        if event.get("updatedAt"):
            payload["updatedAt"] = iso_utc(event["updatedAt"])
        return payload

    workspace = await get_owned(db, Workspace, session.workspace_id, current_user.id) if session.workspace_id else None
    session_context = session.session_context if isinstance(session.session_context, dict) else {}
    active_filesystem_grant = await get_active_grant(
        db,
        current_user.id,
        subject_type=SUBJECT_SESSION,
        subject_id=session.id,
    ) if filesystem_authorization_enabled() else None
    pending_queue: list[dict] = []
    pending_queue = await conversation_pending_queue.get_pending_queue_for_session(
        db,
        user_id=current_user.id,
        session_id=session.id,
    )
    return {
        "session": {"id": session.id, "title": session.title, "chatType": session.chat_type,
                    "ownerPlatformUserId": owner_platform_user_id,
                    "workspaceName": workspace.name if workspace and workspace_shell_supported() else None,
                    "filesystemAuthorized": active_filesystem_grant is not None,
                    "filesystemAuthorizationEnabled": filesystem_authorization_enabled(),
                    "goalActive": bool(session_context.get("goal_mode") and session_context.get("goal_text")),
                    "goalStatus": "paused" if session_context.get("goal_status") == "paused" and session_context.get("goal_text") else ("active" if session_context.get("goal_text") else None)},
        "active": await genstream.is_active(session_id),   # 该会话是否正在生成（前端据此续看）
        # 排队/基线整理是持久状态，刷新或切回会话后前端据此恢复「正在整理上下文」提示
        "executionState": session.execution_state,
        "pendingMessageCount": int(session.pending_message_count or 0),
        "pendingQueue": pending_queue,
        "pagination": {
            "limit": limit,
            "hasMore": has_more,
            "hasNewer": has_newer,
            "oldestId": page_rows[0].id if page_rows else None,
            "newestId": page_rows[-1].id if page_rows else None,
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
             "runOutcome": m.run_outcome,
             "runId": m.run_id,
             "roundId": m.round_id,
             **({"timelineOmitted": True} if m.id in oversized_timeline_ids else {}),
             "createdAt": iso_utc(m.created_at)}
            for m in msgs
            if not (m.role == "assistant" and display_timeline_by_id.get(m.id))
        ],
        "timelineEvents": [
            {**{key: value for key, value in strip_image_for_history(item).items()
                if not (item.get("kind") == "tool" and key in {"toolInput", "toolResult"})},
             "id": f"{m.id}:{index}",
             "messageId": m.id,
             "timelineOrder": item.get("timelineOrder") or m.id * 1000 + index + 1,
             "createdAt": iso_utc(m.created_at)}
             | ({"detailsAvailable": True, "detailSource": {"kind": "timeline", "messageId": m.id, "index": index}}
                if item.get("kind") == "tool" and ("toolInput" in item or "toolResult" in item) else {})
            for m in msgs
            for index, item in enumerate(timeline_items(m))
        ],
        "toolEvents": [
            serialize_tool_event(event)
            for event in tool_events
        ],
    }

@router.get("/sessions/{session_id}/tool-event-details")
async def get_session_tool_event_details(
    session_id: int,
    source: Literal["timeline", "canonical"],
    message_id: Optional[int] = None,
    timeline_index: Optional[int] = Query(default=None, ge=0),
    run_id: Optional[str] = Query(default=None, min_length=1, max_length=128),
    round_id: Optional[str] = Query(default=None, min_length=1, max_length=128),
    tool_call_id: Optional[str] = Query(default=None, min_length=1, max_length=256),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """按需读取单个历史工具气泡详情；每次都先校验会话归属。"""
    from agent.media.images import strip_image_for_history

    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")

    if source == "timeline":
        if message_id is None or timeline_index is None or any((run_id, round_id, tool_call_id)):
            raise HTTPException(400, "工具事件标识无效")
        timeline_column = ConversationMessage.display_timeline
        if db.get_bind().dialect.name == "postgresql":
            stored_size = func.pg_column_size(timeline_column)
        else:
            stored_size = func.length(cast(timeline_column, Text))
        timeline_projection = case((stored_size > 1024 * 1024, None), else_=timeline_column)
        row = (await db.execute(
            select(timeline_projection).where(
                ConversationMessage.id == message_id,
                ConversationMessage.session_id == session_id,
                ConversationMessage.content_json.is_(None),
            )
        )).scalar_one_or_none()
        items = merge_tool_timeline_items(row) if isinstance(row, list) else []
        if timeline_index >= len(items) or items[timeline_index].get("kind") != "tool":
            raise HTTPException(404, "工具事件不存在")
        event = items[timeline_index]
        return strip_image_for_history({key: event[key] for key in ("toolInput", "toolResult") if key in event})

    if not run_id or not round_id or not tool_call_id or message_id is not None or timeline_index is not None:
        raise HTTPException(400, "工具事件标识无效")
    rows = (await db.execute(
        select(ConversationMessage).options(load_only(
            ConversationMessage.id,
            ConversationMessage.session_id,
            ConversationMessage.content_json,
            ConversationMessage.run_id,
            ConversationMessage.round_id,
            ConversationMessage.canonical_batch_id,
            ConversationMessage.created_at,
        )).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.content_json.is_not(None),
            ConversationMessage.run_id == run_id,
            ConversationMessage.round_id == round_id,
        ).order_by(ConversationMessage.id)
    )).scalars().all()
    event = next((item for item in build_chat_tool_events(rows) if item.get("toolCallId") == tool_call_id), None)
    if event is None:
        raise HTTPException(404, "工具事件不存在")
    return strip_image_for_history({key: event[key] for key in ("toolInput", "toolResult") if key in event})

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
        .where(
            ConversationMessage.id == message_id,
            ConversationMessage.content_json.is_(None),
            ConversationMessage.role != "summary",
        )
    )).first()
    if not row or row[1] != current_user.id:
        raise HTTPException(404, "消息不存在")
    m = row[0]
    return {"id": m.id, "sessionId": m.session_id}

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
    ``conversation.session_metadata.generate_title_bg`` 在写 title 前会查这个标志，是 True 直接跳过——手动改名
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
