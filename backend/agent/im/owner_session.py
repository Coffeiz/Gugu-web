"""Owner IM 与 Web 会话的显式绑定。

绑定只影响 owner 私聊，不改变群聊 session，也不会因为用户拥有多个 Web
session 就自动拼接它们的正文。
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import or_, select

from app.core import redis as redis_core
from app.core.ownership import get_owned

OWNER_SESSION_TTL = 12 * 3600


def _key(user_id, platform: str, platform_user_id: str, bot_id: str | None = None) -> str:
    suffix = f":{bot_id}" if bot_id else ""
    return f"im:owner-session:{user_id}:{platform}:{platform_user_id}{suffix}"


async def get_bound_session(
    user_id, platform: str, platform_user_id: str, bot_id: str | None = None
) -> Optional[int]:
    """读取 owner 私聊的显式 Web session 绑定。"""
    if not user_id or not platform or not platform_user_id:
        return None
    raw = await redis_core.get_redis().get(_key(user_id, platform, platform_user_id, bot_id))
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


async def bind_session(
    db, user_id, platform: str, platform_user_id: str, session_id: int,
    bot_id: str | None = None,
) -> bool:
    """绑定一个属于当前用户的 Web session，成功返回 True。"""
    if not platform or not platform_user_id or not session_id:
        return False
    from app.models import ConversationSession

    session = await get_owned(db, ConversationSession, session_id, user_id)
    if not session or session.source not in (None, "web"):
        return False
    await redis_core.get_redis().set(
        _key(user_id, platform, platform_user_id, bot_id),
        str(session_id),
        ex=OWNER_SESSION_TTL,
    )
    return True


async def bind_session_by_id(
    platform: str, platform_user_id: str, session_id: int, bot_id: str | None = None
) -> bool:
    """按已生成的 Web session 反查用户并写回 owner 私聊绑定。

    IM worker 只有 session id 和平台发言人，不应重新推断用户身份；session
    本身是服务端已创建且归属明确的记录，因此这里只允许 Web session 或当前平台
    创建的 session 进入绑定。
    """
    if not platform or not platform_user_id or not session_id:
        return False
    import app.db.session as db_session
    from app.models import ConversationSession

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        owner = (await db.execute(
            select(ConversationSession.user_id).where(
                ConversationSession.id == session_id,
                or_(
                    ConversationSession.source.is_(None),
                    ConversationSession.source == "web",
                ConversationSession.source == platform,
            ),
            ConversationSession.bot_id == bot_id if bot_id else ConversationSession.bot_id.is_(None),
            )
        )).scalar_one_or_none()
    if owner is None:
        return False
    return await _write_binding(owner, platform, platform_user_id, session_id, bot_id)


async def _write_binding(
    user_id, platform: str, platform_user_id: str, session_id: int,
    bot_id: str | None = None,
) -> bool:
    """写入已经完成归属校验的绑定。"""
    if not user_id or not platform or not platform_user_id or not session_id:
        return False
    await redis_core.get_redis().set(
        _key(user_id, platform, platform_user_id, bot_id),
        str(session_id),
        ex=OWNER_SESSION_TTL,
    )
    return True


async def clear_binding(
    user_id, platform: str, platform_user_id: str, bot_id: str | None = None
) -> None:
    """清除 owner 私聊的显式 Web session 绑定。"""
    if user_id and platform and platform_user_id:
        await redis_core.get_redis().delete(_key(user_id, platform, platform_user_id, bot_id))


async def resolve_session(
    user_id,
    platform: str,
    platform_user_id: str,
    explicit_session_id: Optional[int] = None,
    bot_id: str | None = None,
) -> Optional[int]:
    """显式 session 优先，否则读取绑定；不负责群聊路由。"""
    if explicit_session_id:
        return explicit_session_id
    return await get_bound_session(user_id, platform, platform_user_id, bot_id)
