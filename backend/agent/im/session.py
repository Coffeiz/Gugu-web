"""IM 会话路由与群消息保留策略。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from sqlalchemy import delete, desc, func, select

from app.core import redis as R

IM_SESSION_TTL = 12 * 3600  # 12 小时滑动 TTL
GROUP_MESSAGE_LIMIT = 50


@dataclass(frozen=True)
class SessionRoute:
    """一次 IM 消息对应的会话作用域。"""

    scope_id: str
    chat_type: str

    @property
    def is_group(self) -> bool:
        return self.chat_type == "group"


def session_key(platform: str, scope_id: str) -> str:
    """按平台和会话作用域生成 Redis key。"""
    return f"imsession:{platform}:{scope_id}"


def resolve_route(platform_message, payload: dict) -> SessionRoute:
    """按平台无关消息确定群/私聊 session 作用域。"""
    chat_type = platform_message.chat.type or payload.get("chat_type") or "c2c"
    if chat_type == "group":
        scope_id = platform_message.chat.id or payload.get("chat_id") or ""
    else:
        scope_id = platform_message.sender.id or payload.get("platform_user_id") or ""
    return SessionRoute(str(scope_id), str(chat_type))


def session_scope_filters(model, source: str, chat_id: Optional[str]) -> list:
    """生成 IM 会话归属条件；Web 调用方不应使用此过滤器。"""
    if source not in {"feishu", "qqbot", "wechat"}:
        return []
    return [
        model.source == source,
        model.chat_id == chat_id if chat_id else model.chat_id.is_(None),
    ]


async def get_session(platform: str, scope_id: str):
    if not platform or not scope_id:
        return None
    raw = await R.get_redis().get(session_key(platform, scope_id))
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


async def set_session(platform: str, scope_id: str, session_id) -> None:
    if platform and scope_id and session_id:
        await R.get_redis().set(
            session_key(platform, scope_id), str(session_id), ex=IM_SESSION_TTL
        )


async def resolve_session_id(
    platform: str,
    route: SessionRoute,
    explicit_session_id: Optional[int] = None,
    getter: Callable[[str, str], Awaitable[Optional[int]]] = get_session,
) -> Optional[int]:
    """显式 session 优先，否则按路由作用域读取 Redis session。"""
    return explicit_session_id or await getter(platform, route.scope_id)


@dataclass(frozen=True)
class SessionState:
    """一次请求解析出的数据库会话状态。"""

    session: object
    is_new: bool


async def get_or_create_session(db, request, user_id, max_sessions: int = 50) -> SessionState:
    """按请求作用域查找或创建会话，并限制用户会话数量。"""
    from app.models import ConversationSession

    session = None
    if request.session_id:
        session = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.id == request.session_id,
                ConversationSession.user_id == user_id,
                *session_scope_filters(ConversationSession, request.source, request.chat_id),
            )
        )).scalars().first()
    if session:
        return SessionState(session, False)

    session_count = (await db.execute(
        select(func.count()).select_from(ConversationSession)
        .where(ConversationSession.user_id == user_id)
    )).scalar_one()
    if session_count >= max_sessions:
        oldest = (await db.execute(
            select(ConversationSession)
            .where(ConversationSession.user_id == user_id)
            .order_by(ConversationSession.updated_at.asc())
            .limit(1)
        )).scalars().first()
        if oldest:
            await db.delete(oldest)
    session = ConversationSession(
        user_id=user_id,
        title=(request.message[:50] or "新对话"),
        source=getattr(request, "source", "web"),
        chat_id=request.chat_id,
    )
    db.add(session)
    await db.flush()
    return SessionState(session, True)


async def trim_group_messages(session_id: int, limit: int = GROUP_MESSAGE_LIMIT) -> None:
    """只保留群会话最近的消息记录，避免普通群消息无限增长。"""
    if limit < 1:
        return
    import app.db.session as db_session
    from app.models import ConversationMessage

    if db_session._engine is None:
        db_session._build_engine()
    keep_ids = (
        select(ConversationMessage.id)
        .where(ConversationMessage.session_id == session_id)
        .order_by(desc(ConversationMessage.created_at), desc(ConversationMessage.id))
        .limit(limit)
    )
    async with db_session._SessionLocal() as db:
        await db.execute(
            delete(ConversationMessage).where(
                ConversationMessage.session_id == session_id,
                ConversationMessage.id.not_in(keep_ids),
            )
        )
        await db.commit()
