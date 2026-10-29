"""IM 会话与被动群消息持久化。"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from agent.im.context_policy import IM_SOURCES
from agent.im.owner_session import bind_session_by_id
from agent.im.session import SessionRoute, set_session
from agent.models import AgentRequest
from app.services.conversation_retention import trim_session_messages


class GroupInboundMode(str, Enum):
    """群消息的入站分类。"""

    PASSIVE = "passive"   # 只记录不回复
    REPLY = "reply"       # 进 run，由模型决定是否回话


def classify_group_inbound(payload: dict) -> Optional[GroupInboundMode]:
    """按群回复模式把一条群消息分成「只记录」和「进 run」两类。

    判定只依赖网关已经写入的回应方式字段，不解析身份、不读数据库——被动消息必须
    能在同一群的主动任务运行期间实时落库并推送前端。

    ``None`` 表示这不是群消息（私聊/非 IM 平台），调用方按各自入口处理。
    """
    if not (
        payload.get("platform") in {"qq", "feishu", "telegram"}
        and payload.get("chat_type") == "group"
        and payload.get("chat_id")
    ):
        return None
    if (
        payload.get("group_read_enabled")
        or (
            payload.get("group_requires_at")
            and not payload.get("group_mentioned")
        )
        or (
            payload.get("mentions_other_bot")
            and not payload.get("group_mentioned")
        )
    ):
        return GroupInboundMode.PASSIVE
    return GroupInboundMode.REPLY


async def build_attachment_cards(user_id, attach_ids: list) -> list[dict]:
    """整理会话气泡用的附件卡片；只读元数据，**不** claim。

    claim 必须留在 run 的"消息 + 附件同一事务"里（PRD-STORAGE-1 不变量 3）：
    提前 claim 会让 run 后续 claim 不到、误判附件已失效。
    """
    if not attach_ids:
        return []
    from app.core import chat_attach

    metas = await chat_attach.get_meta_many(user_id, attach_ids)
    cards = []
    for attach_id in attach_ids:
        meta = metas.get(str(attach_id))
        if not meta:
            continue
        cards.append({
            "attach_id": meta["attach_id"],
            "name": meta["name"],
            "ext": meta["ext"],
            "size_bytes": meta["size"],
            "kind": meta["kind"],
            "mime": meta.get("mime"),
            "qq_face": bool(meta.get("qq_face")),
            "quoted": bool(meta.get("quoted")),
            "upload": True,
            "duration": meta.get("duration"),
            "img_width": meta.get("img_width"),
            "img_height": meta.get("img_height"),
        })
    return cards


async def record_passive_im_message(request: AgentRequest, session_id: Optional[int] = None) -> int:
    """保存未触发回复的群消息，供后续 @ 咕咕时读取同一会话上下文。"""
    import app.db.session as db_session
    from sqlalchemy import desc, select
    from app.models import ConversationMessage, ConversationSession

    attachment_cards = await build_attachment_cards(request.user_id, request.attachments)

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id) if session_id else None
        if session is not None and (
            session.user_id != request.user_id
            or session.source != (request.source or "qq")
            or session.bot_id != request.platform_bot_id
            or session.chat_id != request.chat_id
        ):
            # Redis 路由异常或旧 key 不得把消息写进另一个 Bot/群的会话。
            session = None
        if session is None and request.chat_id:
            # Redis 只是路由缓存：过期、重启或并发 miss 时，必须按稳定的群作用域
            # 回查数据库，不能因为缓存缺失给同一个群重复创建会话。
            session = (await db.execute(
                select(ConversationSession)
                .where(
                    ConversationSession.user_id == request.user_id,
                    ConversationSession.source == (request.source or "qq"),
                    ConversationSession.bot_id == request.platform_bot_id,
                    ConversationSession.chat_id == request.chat_id,
                    ConversationSession.chat_type == "group",
                )
                .order_by(desc(ConversationSession.updated_at), desc(ConversationSession.id))
                .limit(1)
            )).scalars().first()
        if session is None:
            session = ConversationSession(
                user_id=request.user_id,
                title=(request.message[:50] or "群聊记录"),
                source=request.source or "qq",
                bot_id=request.platform_bot_id,
                chat_id=request.chat_id,
                chat_type=("group" if request.chat_id else
                           "c2c" if request.source in IM_SOURCES else None),
            )
            db.add(session)
            await db.flush()
        message_row = ConversationMessage(
            session_id=session.id,
            role="user",
            content=request.message,
            quoted_text=request.quoted_text,
            platform_user_id=request.platform_user_id,
            platform_user_name=request.platform_user_name,
            platform_bot_user_id=request.platform_bot_user_id,
            chat_type=("group" if request.chat_id else
                       "c2c" if request.source in IM_SOURCES else None),
            files=attachment_cards or None,
        )
        db.add(message_row)
        await db.flush()
        # 被动记录路径，同样遵守"消息+附件 claim 同事务"（不变量 3）；这里失败极罕见
        # （只可能是并发 claim/GC 抢跑），rollback 后跳过这条消息记录，不影响群聊主链路。
        from app.core import chat_attach
        try:
            await chat_attach.claim_attachments(
                db, request.user_id, message_row.id,
                [c["attach_id"] for c in attachment_cards])
        except chat_attach.AttachmentClaimError as exc:
            await db.rollback()
            from app.core.redaction import diag_log
            diag_log("agent.im.conversation.record_passive_im_message.claim", exc)
            return session_id or session.id
        await db.commit()
        await trim_session_messages(session.id)
        # 被动群消息不经过 runner，单独补发会话增量，网页才能实时看到这条已记录消息。
        try:
            from app.core import events

            await events.publish(
                request.user_id,
                "sessions",
                session_id=session.id,
                appended=[{
                    "role": "user",
                    "message_id": message_row.id,
                    "text": request.message,
                    "platform_user_id": request.platform_user_id,
                    "platform_user_name": request.platform_user_name,
                    "platform_bot_user_id": request.platform_bot_user_id,
                    "chat_type": "group",
                    "files": attachment_cards,
                }],
            )
        except Exception:
            pass
        recorded_session_id = session.id
        recorded_message_id = message_row.id
    if request.chat_id and recorded_message_id:
        group_threshold_reached = False
        try:
            from agent.memory.reflection_jobs import observe_group_message
            from agent.memory.scopes import MemoryScope

            group_scope = MemoryScope(
                    request.user_id,
                    request.source or "qq",
                    str(request.platform_bot_id or ""),
                    "group",
                    str(request.chat_id),
            )
            if request.im_group_memory_enabled:
                group_job_id = await observe_group_message(
                    group_scope,
                    recorded_message_id,
                    message_row.created_at,
                )
                group_threshold_reached = group_job_id is not None
                if not group_threshold_reached:
                    from agent.memory.group_pressure import observe_passive_context_pressure

                    group_threshold_reached = await observe_passive_context_pressure(
                        group_scope, recorded_session_id,
                    )
            if request.im_role == "owner":
                from app.core.config import get_settings
                from agent.memory import reflection

                reflection.schedule(
                    request.user_id,
                    request.user_name,
                    request.message,
                    "",
                    get_settings(),
                    group_mode=True,
                    session_id=recorded_session_id,
                    flush_now=group_threshold_reached,
                    passive=True,
                )
            elif group_threshold_reached:
                from app.core.config import get_settings
                from agent.memory import reflection

                reflection.flush_group_owner_buffer(
                    request.user_id, get_settings(), recorded_session_id,
                )
        except Exception as exc:
            # 记忆调度不能阻断消息落库和网页会话同步。
            from app.core.redaction import diag_log

            diag_log("agent.im.conversation.passive_reflection_schedule", exc)
    return recorded_session_id


def should_record_passive_group(request: AgentRequest, payload: dict) -> bool:
    """判断是否只记录当前群消息而不触发回复。

    网关始终接收平台实际投递的群消息；这里仅负责回应方式的业务语义：
    ``record_only`` 记录全部消息，``reply_mentions`` 记录非 @ 消息，@ 消息
    继续进入模型回复流程。

    另外，@ 的是**别的 bot** 的消息一律只记录不回复：那条是喊别人家机器人的，
    抢答等于替别人作答。这条不看群回复模式——``reply_all`` 也不该抢答。
    """
    return classify_group_inbound({
        "platform": request.source,
        "chat_type": payload.get("chat_type"),
        "chat_id": request.chat_id,
        "group_read_enabled": payload.get("group_read_enabled"),
        "group_requires_at": payload.get("group_requires_at"),
        "group_mentioned": payload.get("group_mentioned"),
        "mentions_other_bot": payload.get("mentions_other_bot"),
    }) is GroupInboundMode.PASSIVE


async def persist_im_session(
    platform: str,
    bot_id: str,
    scope_id: str,
    session_id: Optional[int],
    *,
    group: bool = False,
) -> None:
    """写回 IM 路由 session，并在私聊/群聊路径统一执行消息窗口裁剪。"""
    if group:
        await set_session(platform, bot_id, scope_id, session_id)
        if session_id:
            await trim_session_messages(session_id)
        return
    # 私聊读取的是 owner-session 绑定，不能再写入旧的通用 imsession key。
    # 这里由 session 记录反查其用户归属，避免从平台字段重新推断 owner。
    await bind_session_by_id(platform, scope_id, session_id, bot_id)
    if session_id:
        await trim_session_messages(session_id)
