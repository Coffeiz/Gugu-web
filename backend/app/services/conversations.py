"""历史对话的查询边界。"""
from sqlalchemy import desc, select

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


async def get_session(db, user_id, session_id):
    return await get_owned(db, ConversationSession, session_id, user_id)


async def list_messages(db, session_id, limit):
    return (await db.execute(select(ConversationMessage).where(
        ConversationMessage.session_id == session_id,
        ConversationMessage.content_json.is_(None),
    ).order_by(desc(ConversationMessage.created_at)).limit(limit))).scalars().all()
