"""历史对话的查询边界。"""
from sqlalchemy import case, desc, func, select

from app.core.ownership import get_owned
from app.models import ConversationMessage, ConversationSession
from app.search.query import keyword_condition, keyword_score


async def list_recent_sessions(db, user_id, limit):
    return (await db.execute(select(ConversationSession).where(
        ConversationSession.user_id == user_id,
    ).order_by(desc(ConversationSession.updated_at)).limit(limit))).scalars().all()


async def search_messages(db, user_id, queries, mode, limit):
    conditions = keyword_condition(
        [ConversationMessage.content, ConversationSession.title, ConversationSession.summary],
        queries,
        mode,
    )
    return (await db.execute(
        select(ConversationMessage, ConversationSession)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationSession.user_id == user_id, ConversationMessage.content_json.is_(None), conditions)
        .order_by(keyword_score([
            ConversationMessage.content, ConversationSession.title, ConversationSession.summary,
        ], queries).desc(), desc(ConversationMessage.created_at))
        .limit(limit)
    )).all()


async def search_session_titles(db, user_id, queries, mode, limit, primary_query=None):
    """按会话标题搜索当前用户的会话。"""
    primary_query = (primary_query or queries[0]).lower()
    return (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_id,
            keyword_condition([ConversationSession.title], queries, mode),
        ).order_by(
            keyword_score([ConversationSession.title], queries).desc(),
            case(
                (func.lower(ConversationSession.title) == primary_query, 0),
                (func.lower(ConversationSession.title).like(f"{primary_query}%"), 1),
                else_=2,
            ),
            desc(ConversationSession.updated_at),
        ).limit(limit)
    )).scalars().all()


async def search_global_messages(db, user_id, queries, mode, limit):
    """为站内搜索返回消息及其会话标题。"""
    return (await db.execute(
        select(ConversationMessage, ConversationSession.title)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationSession.user_id == user_id,
            keyword_condition([ConversationMessage.content], queries, mode),
        ).order_by(
            keyword_score([ConversationMessage.content], queries).desc(),
            desc(ConversationMessage.created_at),
        ).limit(limit)
    )).all()


async def list_sessions_for_search_scan(db, user_id, limit):
    """返回罗马音搜索需要扫描的当前用户会话。"""
    return (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_id,
        ).order_by(desc(ConversationSession.updated_at)).limit(limit)
    )).scalars().all()


async def list_messages_for_search_scan(db, user_id, limit):
    """返回罗马音搜索需要扫描的当前用户消息及会话标题。"""
    return (await db.execute(
        select(ConversationMessage, ConversationSession.title)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationSession.user_id == user_id)
        .order_by(desc(ConversationMessage.created_at)).limit(limit)
    )).all()


async def get_session(db, user_id, session_id):
    return await get_owned(db, ConversationSession, session_id, user_id)


async def list_messages(db, session_id, limit):
    return (await db.execute(select(ConversationMessage).where(
        ConversationMessage.session_id == session_id,
        ConversationMessage.content_json.is_(None),
    ).order_by(desc(ConversationMessage.created_at)).limit(limit))).scalars().all()
