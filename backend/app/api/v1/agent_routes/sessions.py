"""Agent API sessions endpoints."""

import json
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agent.im.models import extract_mention_ids, replace_mention_ids
from agent.llm import genstream
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.core.tz import iso_utc
from app.db.session import get_db
from app.models import ConversationMessage, ConversationSession, User, Workspace
from app.services import conversation_pending_queue, conversations
from app.services.filesystem_authorization import SUBJECT_SESSION, filesystem_authorization_enabled, get_active_grant
from app.services.workspaces import workspace_shell_supported

router = APIRouter()


@router.get("/sessions")
async def list_sessions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sessions = await conversations.list_agent_sessions(db, current_user.id)
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
        authorized_session_ids = await conversations.list_active_session_authorization_ids(
            db, current_user.id,
        )

    web_ids = [s.id for s, _ in sessions if not s.source or s.source == "web"]
    running = await genstream.active_statuses([s.id for s, _ in sessions])
    # 仅已完成、可见的正文推进未读版本；工具历史与空检查点不参与。
    replies = await conversations.latest_visible_assistant_message_ids(db, web_ids)

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
            "isRunning": running.get(s.id),
            **({"lastAssistantId": replies.get(s.id, 0)}
               if s.id in web_ids else {}),
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


async def _group_mention_names(
    db,
    session: ConversationSession,
    msgs: list[ConversationMessage],
    user_id,
    bot_platform_user_id: Optional[str],
) -> dict[str, str]:
    """解析群聊里 @ 到的对象各自显示成什么名字。

    取值按可信度排序：

    1. 会话内真实发言记录里的昵称——群成员和机器人发言都带平台昵称，所以
       @ 到别的 bot 时显示它自己的名字，不再一律显示"咕咕"（群里同时有
       多个 bot 时，"咕咕"会指错对象）。
    2. 当前会话自己的 bot → 咕咕（产品自称，和群里看到的昵称一致）。
    3. 用户在同一平台的其它 bot → 它在 IM 配置里起的名字。
    4. 解析不到 → 不放进映射，原始平台 ID 保持原样（不猜名字）。
    """
    if session.chat_type != "group":
        return {}
    candidate_ids: set[str] = set()
    for message in msgs:
        if message.platform_bot_user_id:
            candidate_ids.add(str(message.platform_bot_user_id))
        # 正文和引用原文里都可能有 @，两边都要收候选 ID，否则引用框里会露原始 ID。
        candidate_ids.update(extract_mention_ids(message.content or ""))
        candidate_ids.update(extract_mention_ids(message.quoted_text or ""))
    names: dict[str, str] = {}
    if candidate_ids:
        names.update(await conversations.get_session_display_names(db, session.id, candidate_ids))
    if bot_platform_user_id:
        names.setdefault(str(bot_platform_user_id), "咕咕")
    unresolved = candidate_ids - set(names)
    if unresolved and session.source:
        for platform_user_id, name in (
            await conversations.get_user_bot_display_names(db, user_id, session.source)
        ).items():
            if platform_user_id in unresolved:
                names[platform_user_id] = name
    return names


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: int,
    limit: int = 50,
    before_id: Optional[int] = None,
    after_id: Optional[int] = None,
    run_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")
    # 媒体块只用于模型输入，不随聊天气泡历史重复传输。
    from agent.media.images import strip_image_for_history

    # 刷新/重新进入会话时顺便收口 worker 重启留下的 running 状态，避免
    # 前端后续发送继续被旧 run 的持久化状态阻塞。
    from agent.context.compress_conv import recover_orphaned_session
    await recover_orphaned_session(session_id, user_id=current_user.id)
    limit = min(max(limit, 1), 200)
    # 分页包含正文与工具时间线；数据库在 Service 层延迟大 JSON 并限制投影尺寸。
    page = await conversations.load_display_message_page(
        db,
        session_id,
        limit,
        before_id=before_id,
        after_id=after_id,
        run_id=run_id,
    )
    msgs = page["messages"]
    display_body_ids = page["display_body_ids"]
    display_timeline_by_id = page["timelines"]
    oversized_timeline_ids = page["oversized_timeline_ids"]
    # 群聊消息按发言人区分左右气泡：owner 的平台身份挂在该来源的 UserBot 上
    # （目前只有 QQ 走了绑定流程，其它渠道查不到就是 None，前端据此把消息
    # 归到左侧、标发言人 username，而不是误判成 owner 自己发的）。
    owner_platform_user_id = None
    bot_platform_user_id = None
    if session.source:
        owner_platform_user_id, bot_platform_user_id = await conversations.get_session_owner_platform_ids(
            db, current_user.id, session.source, session.bot_id,
        )
    mention_names = await _group_mention_names(
        db, session, msgs, current_user.id, bot_platform_user_id,
    )

    def render_content(text: str) -> str:
        if session.chat_type != "group":
            return text
        # 只替换当前会话已知的成员和 Bot ID，未知 mention 保留原样。
        return replace_mention_ids(text, mention_names)

    def timeline_items(message: ConversationMessage) -> list[dict]:
        return display_timeline_by_id.get(message.id) or []

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
            "hasMore": page["has_more"],
            "hasNewer": page["has_newer"],
            "oldestId": msgs[0].id if msgs else None,
            "newestId": msgs[-1].id if msgs else None,
        },
        "messages": [
            {"id": m.id, "role": m.role,
             "timelineOrder": m.id * 1_000_000,
             "content": render_content(m.content),
             "files": m.files or [],
             "references": m.references_json or [],
             "quotedText": render_content(m.quoted_text) if m.quoted_text else m.quoted_text,
             "platformUserId": m.platform_user_id,
             "platformUserName": m.platform_user_name,
             "platformBotUserId": m.platform_bot_user_id,
             "runOutcome": m.run_outcome,
             "runId": m.run_id,
             "roundId": m.round_id,
             **({"timelineOmitted": True} if m.id in oversized_timeline_ids else {}),
             "createdAt": iso_utc(m.created_at)}
            for m in msgs
            if m.id in display_body_ids and display_timeline_by_id.get(m.id) is None
        ],
        "timelineEvents": [
            {**{key: value for key, value in strip_image_for_history(item).items()
                if not (item.get("kind") == "tool" and key in {"toolInput", "toolResult"})},
             "id": f"{m.id}:{index}",
             "messageId": m.id,
             "timelineOrder": item["timelineOrder"],
             "createdAt": item["createdAt"]}
             | ({"detailsAvailable": True, "detailSource": {"kind": "timeline", "messageId": m.id, "index": index}}
                if item.get("kind") == "tool" and ("toolInput" in item or "toolResult" in item) else {})
            for m in msgs
            for index, item in enumerate(timeline_items(m))
        ],
    }

@router.get("/sessions/{session_id}/tool-event-details")
async def get_session_tool_event_details(
    session_id: int,
    source: Literal["timeline"],
    message_id: Optional[int] = None,
    timeline_index: Optional[int] = Query(default=None, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """按需读取单个历史工具气泡详情；每次都先校验会话归属。"""
    from agent.media.images import strip_image_for_history

    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if not session:
        raise HTTPException(404, "对话不存在")

    if message_id is None or timeline_index is None:
        raise HTTPException(400, "工具事件标识无效")
    row = await conversations.get_display_timeline_item(db, session_id, message_id)
    items = row if isinstance(row, list) else []
    if timeline_index >= len(items) or items[timeline_index].get("kind") != "tool":
        raise HTTPException(404, "工具事件不存在")
    event = items[timeline_index]
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
    row = await conversations.resolve_display_message_location(db, current_user.id, message_id)
    if row is None:
        raise HTTPException(404, "消息不存在")
    return {"id": row[0], "sessionId": row[1]}

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
