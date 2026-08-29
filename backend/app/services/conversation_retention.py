"""跨平台会话消息保留策略。"""
from __future__ import annotations

from sqlalchemy import desc, func, select

from app.services.conversation_cleanup import remove_messages_with_attachments


# 所有会话类型共用这组物理保留边界；上下文读取窗口由各自的 history policy 单独决定。
MESSAGE_RETENTION_LIMIT = 500
MESSAGE_TRIM_THRESHOLD = 600


async def trim_session_messages(
    session_id: int,
    limit: int = MESSAGE_RETENTION_LIMIT,
    threshold: int = MESSAGE_TRIM_THRESHOLD,
) -> None:
    """超过阈值时只保留会话最近的消息，并清理随消息保存的附件。

    裁剪发生在一轮完整持久化之后，避免删除仍可能被当前 provider round 使用的
    历史。阈值和上限对 Web、IM、主动消息等会话来源一致。
    """
    if limit < 1:
        return

    import app.db.session as db_session
    from app.models import ConversationMessage

    if db_session._engine is None:
        db_session._build_engine()
    async with db_session._SessionLocal() as db:
        count = (await db.execute(
            select(func.count()).select_from(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
        )).scalar_one()
        if count <= threshold:
            return

        keep_ids = (
            select(ConversationMessage.id)
            .where(ConversationMessage.session_id == session_id)
            .order_by(desc(ConversationMessage.created_at), desc(ConversationMessage.id))
            .limit(limit)
        )
        old_ids = list((await db.execute(
            select(ConversationMessage.id).where(
                ConversationMessage.session_id == session_id,
                ConversationMessage.id.not_in(keep_ids),
            )
        )).scalars().all())
        await remove_messages_with_attachments(db, old_ids)
