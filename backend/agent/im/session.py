"""IM 会话路由与群消息保留策略。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from sqlalchemy import delete, desc, func, select

from app.core import redis as R
from agent.im.context_policy import IM_SOURCES

IM_SESSION_TTL = 12 * 3600  # 12 小时滑动 TTL
GROUP_MESSAGE_RETENTION_LIMIT = 500
GROUP_CONTEXT_LIMIT = 50


@dataclass(frozen=True)
class SessionRoute:
    """一次 IM 消息对应的会话作用域。

    ``bot_id`` 是 BYO 模型下必须区分的一环：同一 Gugu 账号可以注册多个同
    平台 bot，同一外部平台账号也可能同时是两个不同 bot 的联系人/群成员；
    没有 ``bot_id``，两个不同 bot 的会话作用域可能因为 ``scope_id`` 碰巧
    相同而串到一起。
    """

    bot_id: str
    scope_id: str
    chat_type: str

    @property
    def is_group(self) -> bool:
        return self.chat_type == "group"


@dataclass(frozen=True)
class ImConversationKey:
    """一次 IM 会话的完整、不可变身份——防抖 buffer、串行锁和并发状态的唯一 key。

    只用 ``platform_user_id`` 当 key 时，同一用户跨 bot、跨群或私聊/群聊同时
    发消息，可能被防抖误合并成同一轮处理（见 PRD-IM-2 Phase 5 §1 P1）。四个
    字段缺一都可能碰撞，因此不提供只传部分字段的构造方式。
    """

    platform: str
    bot_id: str
    chat_type: str
    scope_id: str


def conversation_key(payload: dict) -> ImConversationKey:
    """从原始网关 payload 直接算出会话 key，供防抖/锁在身份解析之前使用。

    只读路由字段，不做身份/权限解析，可在 ``prepare_message()`` 之前调用；
    和 ``resolve_route()`` 共用同一套 chat_type/scope_id 推导逻辑，避免两处
    分别维护"群走 chat_id、私聊走 platform_user_id"这条规则。
    """
    from agent.im.models import PlatformMessage

    platform_message = PlatformMessage.from_payload(payload)
    route = resolve_route(platform_message, payload)
    return ImConversationKey(
        platform=platform_message.platform or "",
        bot_id=route.bot_id,
        chat_type=route.chat_type,
        scope_id=route.scope_id,
    )


def session_key(platform: str, bot_id: str, scope_id: str) -> str:
    """按平台、bot 和会话作用域生成 Redis key。"""
    return f"imsession:{platform}:{bot_id}:{scope_id}"


def resolve_route(platform_message, payload: dict) -> SessionRoute:
    """按平台无关消息确定群/私聊 session 作用域。"""
    chat_type = platform_message.chat.type or payload.get("chat_type") or "c2c"
    if chat_type == "group":
        scope_id = platform_message.chat.id or payload.get("chat_id") or ""
    else:
        scope_id = platform_message.sender.id or payload.get("platform_user_id") or ""
    bot_id = platform_message.bot_id or payload.get("bot_id") or payload.get("channel_id") or ""
    return SessionRoute(str(bot_id), str(scope_id), str(chat_type))


def session_scope_filters(
    model,
    source: str,
    chat_id: Optional[str],
    bot_id: Optional[str] = None,
) -> list:
    """生成 IM 会话归属条件；Web 调用方不应使用此过滤器。"""
    if source not in {"feishu", "qq", "wechat"}:
        return []
    return [
        model.source == source,
        model.bot_id == bot_id if bot_id else model.bot_id.is_(None),
        model.chat_id == chat_id if chat_id else model.chat_id.is_(None),
    ]


async def get_session(platform: str, bot_id: str, scope_id: str):
    if not platform or not bot_id or not scope_id:
        return None
    raw = await R.get_redis().get(session_key(platform, bot_id, scope_id))
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


async def set_session(platform: str, bot_id: str, scope_id: str, session_id) -> None:
    if platform and bot_id and scope_id and session_id:
        await R.get_redis().set(
            session_key(platform, bot_id, scope_id), str(session_id), ex=IM_SESSION_TTL
        )


async def resolve_session_id(
    platform: str,
    route: SessionRoute,
    explicit_session_id: Optional[int] = None,
    getter: Callable[[str, str, str], Awaitable[Optional[int]]] = get_session,
) -> Optional[int]:
    """显式 session 优先，否则按路由作用域读取 Redis session。"""
    return explicit_session_id or await getter(platform, route.bot_id, route.scope_id)


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
                *session_scope_filters(
                    ConversationSession,
                    request.source,
                    request.chat_id,
                    getattr(request, "platform_bot_id", None),
                ),
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
    source = getattr(request, "source", "web")
    session = ConversationSession(
        user_id=user_id,
        title=(request.message[:50] or "新对话"),
        source=source,
        bot_id=getattr(request, "platform_bot_id", None),
        chat_id=request.chat_id,
        chat_type=("group" if request.chat_id else "c2c" if source in IM_SOURCES else None),
    )
    db.add(session)
    await db.flush()
    return SessionState(session, True)


async def trim_group_messages(
    session_id: int,
    limit: int = GROUP_MESSAGE_RETENTION_LIMIT,
) -> None:
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
