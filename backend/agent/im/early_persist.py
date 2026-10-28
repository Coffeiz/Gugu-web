"""IM 消息早落库：消息先入库并推到网页，不等当前 run 跑完。

run 的对话历史是从数据库加载的，所以「run 开始时能看到完整最新消息」只需要消息提前
落库；但提前落的行会被 run 的历史读到、跟当前轮正文重复，因此 run 必须**复用**那一行
（把 run_id 从早落库标记改成批次键），不能另插一行。

早落库行用临时 run_id（``im-pending:`` 前缀）标记两件事：

1. 它还没被任何 run 消费——run 读历史要排除这类行，否则同一段话在上下文里出现两次；
2. 它是这条消息的幂等键——同一条消息被重投时复用同一行，不会插出第二条。

边界：

- 只往**已存在**的会话里写。建会话留给 run 路径（那边按会话锁串行），避免早落库和
  run 并发创建重复会话。新会话的第一条消息不早落库。
- 只写附件卡片、**不** claim 附件：claim 必须留在 run 的「消息 + 附件同一事务」里
  （PRD-STORAGE-1 不变量 3），早落库提前 claim 会让 run 后续 claim 不到、误判附件已失效。
"""
from __future__ import annotations

from typing import Optional

from agent.im.context_policy import IM_SOURCES
from agent.im.conversation import GroupInboundMode, build_attachment_cards, classify_group_inbound
from agent.im.inbound_recovery import pending_user_run_key
from agent.im.models import PlatformMessage
from agent.im.session import resolve_route, session_scope_filters


def _should_persist_early(payload: dict, platform_message: PlatformMessage) -> bool:
    if platform_message.platform not in IM_SOURCES:
        return False
    # Telegram owner 绑定码是控制消息：dispatch 会消费，但不能进入历史/SSE。
    if platform_message.platform == "telegram" and payload.get("telegram_command") == "bind":
        return False
    if platform_message.chat.type == "c2c":
        return True
    if platform_message.chat.type != "group":
        return False
    return (
        payload.get("group_enabled") is not False
        and classify_group_inbound(payload) is GroupInboundMode.REPLY
    )


async def persist_early_im_message(payload: dict, *, message_id: str) -> Optional[int]:
    """把一条要进 run 的 IM 消息提前落库，返回写入的消息行 id。

    私聊正常入 run；群聊仅允许回复模式入 run。会话还不存在或身份解析失败时返回
    ``None``，run 路径会在自身事务中补写消息，不会丢失。
    """
    platform_message = PlatformMessage.from_payload(payload)
    if not _should_persist_early(payload, platform_message):
        return None
    text = str(payload.get("text") or "")
    attachments = list(payload.get("attachments") or [])
    if not text.strip() and not attachments:
        return None

    from agent.im.identity import resolve_owner_account

    identity = await resolve_owner_account(payload)
    if identity is None:
        return None

    route = resolve_route(platform_message, payload)
    platform = platform_message.platform or "qq"
    pending_key = pending_user_run_key(message_id)

    import app.db.session as db_session
    from sqlalchemy import desc, select
    from app.models import ConversationMessage, ConversationSession

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        existing = (await db.execute(
            select(ConversationMessage).where(ConversationMessage.run_id == pending_key)
        )).scalars().first()
        if existing is not None:
            # 重投：复用同一条早落库行，不插第二条。
            return existing.id

        scope_filters = session_scope_filters(
            ConversationSession,
            platform,
            route.scope_id if route.is_group else None,
            route.bot_id,
            payload.get("platform_user_id"),
        )
        if not scope_filters:
            return None
        session = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.user_id == identity.user_id,
                *scope_filters,
            ).order_by(desc(ConversationSession.updated_at), desc(ConversationSession.id)).limit(1)
        )).scalars().first()
        if session is None:
            # 会话还不存在：建会话交给 run 路径（那边按会话锁串行，不会建重）。
            return None

        cards = await build_attachment_cards(identity.user_id, attachments)
        row = ConversationMessage(
            session_id=session.id,
            role="user",
            content=text,
            quoted_text=payload.get("quoted_text"),
            platform_user_id=payload.get("platform_user_id"),
            platform_user_name=payload.get("platform_user_name"),
            platform_bot_user_id=payload.get("platform_bot_user_id"),
            chat_type=route.chat_type,
            files=cards or None,
            run_id=pending_key,
        )
        db.add(row)
        await db.flush()
        await db.commit()
        session_id = int(session.id)
        row_id = int(row.id)

    # 网页实时可见的唯一通道：被动记录路径也是靠它把消息推给前端。
    try:
        from app.core import events

        await events.publish(
            identity.user_id,
            "sessions",
            session_id=session_id,
            appended=[{
                "role": "user",
                "text": text,
                "platform_user_id": payload.get("platform_user_id"),
                "platform_user_name": payload.get("platform_user_name"),
                "platform_bot_user_id": payload.get("platform_bot_user_id"),
                "chat_type": route.chat_type,
                "files": cards,
            }],
        )
    except Exception:
        pass
    return row_id


__all__ = ["persist_early_im_message"]
