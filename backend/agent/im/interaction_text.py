"""IM 文本选项交互桥接。"""
from __future__ import annotations

from typing import Any


async def _candidate_session_ids(db, *, user_id: Any, session_id: int | None,
                                 platform: str, bot_id: str | None,
                                 chat_id: str | None,
                                 platform_user_id: str | None) -> list[int]:
    from app.models import ConversationSession
    from agent.im.session import session_scope_filters
    from sqlalchemy import select

    candidate_ids: list[int] = []
    scope_filters = session_scope_filters(
        ConversationSession,
        platform,
        chat_id,
        bot_id,
        platform_user_id,
    ) if platform and platform_user_id else []
    if scope_filters:
        scoped_ids = (await db.execute(
            select(ConversationSession.id)
            .where(ConversationSession.user_id == user_id, *scope_filters)
            .order_by(ConversationSession.updated_at.desc(), ConversationSession.id.desc())
        )).scalars().all()
        scoped_id_set = {int(value) for value in scoped_ids}
        if session_id is not None and int(session_id) in scoped_id_set:
            candidate_ids.append(int(session_id))
        for scoped_id in scoped_ids:
            if int(scoped_id) not in candidate_ids:
                candidate_ids.append(int(scoped_id))
    elif session_id is not None:
        # 缺少完整 IM 作用域时不跨会话猜测；保留显式 session 仅用于测试/内部调用。
        candidate_ids.append(int(session_id))
    return candidate_ids


async def has_active_interaction(*, user_id: Any, platform: str,
                                 bot_id: str | None = None,
                                 chat_id: str | None = None,
                                 platform_user_id: str | None = None) -> bool:
    """判断当前 IM 作用域是否有可被文本回复的活动交互。"""
    if not user_id or not platform or not platform_user_id:
        return False
    from app.db import session as db_session
    from app.models import InteractionPrompt
    from app.core.tz import now_utc
    from sqlalchemy import func, select

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return False
    async with db_session._SessionLocal() as db:
        candidate_ids = await _candidate_session_ids(
            db, user_id=user_id, session_id=None, platform=platform,
            bot_id=bot_id, chat_id=chat_id, platform_user_id=platform_user_id,
        )
        if not candidate_ids:
            return False
        count = await db.scalar(select(func.count()).select_from(InteractionPrompt).where(
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.session_id.in_(candidate_ids),
            InteractionPrompt.status == "active",
            InteractionPrompt.expires_at > now_utc(),
        ))
        return bool(count)


async def consume_text_choice(
    *, user_id: Any, session_id: int | None, text: str, event_id: str | None = None,
    platform: str = "", bot_id: str | None = None,
    chat_id: str | None = None, platform_user_id: str | None = None,
    bot_mentioned: bool = False,
) -> dict | None:
    """在共享 IM Loop 中消费数字/选项文字，避免平台网关重复实现。

    交互 Run 尚未结束时，最终的 IM session binding 可能还没写回 Redis；此时
    用稳定的平台作用域回查数据库，保证私聊回复也能唤醒原 Run。
    """
    from agent.im.mentions import normalize_semantic_text

    text = normalize_semantic_text(text, bot_mentioned=bot_mentioned)
    if not text:
        return None
    from app.db import session as db_session
    from app.services.interactions import consume_choice_text, consume_custom_text

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return None
    async with db_session._SessionLocal() as db:
        candidate_ids = await _candidate_session_ids(
            db, user_id=user_id, session_id=session_id, platform=platform,
            bot_id=bot_id, chat_id=chat_id, platform_user_id=platform_user_id,
        )
        for candidate_id in candidate_ids:
            result = await consume_choice_text(
                db,
                session_id=candidate_id,
                user_id=user_id,
                text=text,
                event_id=event_id,
            )
            if result is not None:
                return result
            result = await consume_custom_text(
                db,
                session_id=candidate_id,
                user_id=user_id,
                text=text,
                event_id=event_id,
            )
            if result is not None:
                return result
        return None


__all__ = ["consume_text_choice", "has_active_interaction"]
