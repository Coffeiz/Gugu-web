"""群上下文消息查询边界。"""
from sqlalchemy import desc, select

from app.models import ConversationMessage, ConversationSession
from app.search.query import keyword_condition


async def live_speaker_index(db, user_id, platform, bot_id, chat_id):
    return (await db.execute(select(
        ConversationMessage.platform_user_id,
        ConversationMessage.platform_user_name,
        ConversationMessage.created_at,
    ).join(ConversationSession, ConversationSession.id == ConversationMessage.session_id).where(
        ConversationSession.user_id == user_id,
        ConversationSession.source == platform,
        ConversationSession.bot_id == bot_id,
        ConversationSession.chat_type == "group",
        ConversationSession.chat_id == chat_id,
        ConversationMessage.role == "user",
        ConversationMessage.platform_user_id.is_not(None),
    ))).all()


async def search_group_messages(db, user_id, chat_id, bot_id, speaker_id, queries, mode, limit):
    query = select(ConversationMessage).join(
        ConversationSession, ConversationMessage.session_id == ConversationSession.id,
    ).where(
        ConversationSession.user_id == user_id,
        ConversationSession.source == "qq",
        ConversationSession.bot_id == bot_id,
        ConversationSession.chat_id == chat_id,
        ConversationMessage.content_json.is_(None),
    ).order_by(desc(ConversationMessage.created_at), desc(ConversationMessage.id)).limit(limit)
    if speaker_id:
        query = query.where(ConversationMessage.platform_user_id == speaker_id)
    if queries:
        query = query.where(keyword_condition([ConversationMessage.content], queries, mode))
    return (await db.execute(query)).scalars().all()
