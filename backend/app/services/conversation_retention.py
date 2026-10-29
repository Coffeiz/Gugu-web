"""跨平台会话消息保留策略。"""
from __future__ import annotations

import logging

from sqlalchemy import asc, case, desc, func, or_, select

from app.services.conversation_cleanup import remove_messages_with_attachments

logger = logging.getLogger(__name__)

# 所有会话类型共用物理保留目标；尚未被摘要覆盖的历史不能按条数删除。
MESSAGE_RETENTION_LIMIT = 2000
MESSAGE_TRIM_THRESHOLD = MESSAGE_RETENTION_LIMIT
MESSAGE_TRIM_BATCH_SIZE = 500


async def _covered_history_baseline(db, session_id: int) -> int:
    """只有存在摘要时才允许按其覆盖水位清理原始消息。"""
    from app.models import ConversationMessage, ConversationSession

    summary = (await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.session_id == session_id, ConversationMessage.role == "summary")
        .order_by(desc(ConversationMessage.conversation_seq))
        .limit(1)
    )).scalar_one_or_none()
    if summary is None:
        return 0
    if summary.covers_until_seq:
        return int(summary.covers_until_seq)
    return int((await db.scalar(
        select(ConversationSession.baseline_message_seq)
        .where(ConversationSession.id == session_id)
    )) or 0)


async def _trim_old_interactions(db, session_id: int) -> None:
    from app.models import ConversationMessage
    from app.services.interactions import trim_finished_interactions

    boundary = await db.scalar(
        select(func.min(ConversationMessage.created_at)).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role != "summary",
        )
    )
    if boundary is not None:
        removed = await trim_finished_interactions(db, session_id=session_id,
                                                   created_before=boundary)
        await db.commit()
        if removed:
            logger.info("[retention] session=%s 裁掉已完结交互卡 %d 张", session_id, removed)


async def trim_session_messages(
    session_id: int,
    limit: int = MESSAGE_RETENTION_LIMIT,
    threshold: int = MESSAGE_TRIM_THRESHOLD,
    batch_size: int = MESSAGE_TRIM_BATCH_SIZE,
) -> None:
    """超过阈值时清理已被摘要覆盖的旧消息和附件。

    裁剪发生在一轮完整持久化之后，避免删除仍可能被当前 provider round 使用的
    历史。阈值和上限对 Web、IM、主动消息等会话来源一致。
    交互卡（interaction_prompts）与消息分开存储、无独立裁切路径——这里按裁切
    边界同步物理删除已完结（resolved/expired/cancelled）的卡片，active 的
    待回复确认门一律保留。
    """
    if limit < 1 or batch_size < 1:
        return

    import app.db.session as db_session
    from agent.im.inbound_recovery import PENDING_USER_RUN_PREFIX
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

        baseline = await _covered_history_baseline(db, session_id)
        if baseline <= 0:
            return

        keep_ids = (
            select(ConversationMessage.id)
            .where(ConversationMessage.session_id == session_id)
            .order_by(
                desc(func.coalesce(
                    ConversationMessage.history_anchor_seq,
                    ConversationMessage.conversation_seq,
                )),
                desc(ConversationMessage.conversation_seq),
            )
            .limit(limit)
        )
        while True:
            old_ids = list((await db.execute(
                select(ConversationMessage.id).where(
                    ConversationMessage.session_id == session_id,
                    ConversationMessage.id.not_in(keep_ids),
                    func.coalesce(
                        ConversationMessage.history_anchor_seq,
                        ConversationMessage.conversation_seq,
                    ) <= baseline,
                    ConversationMessage.role != "summary",
                    or_(
                        ConversationMessage.run_id.is_(None),
                        ConversationMessage.run_id.notlike(PENDING_USER_RUN_PREFIX + "%"),
                    ),
                ).order_by(
                    asc(func.coalesce(
                        ConversationMessage.history_anchor_seq,
                        ConversationMessage.conversation_seq,
                    )),
                    case((ConversationMessage.history_anchor_seq.is_not(None), 0), else_=1),
                    asc(ConversationMessage.conversation_seq),
                ).limit(batch_size)
            )).scalars().all())
            if not old_ids:
                break
            # 每批独立提交并在提交后清理附件引用；中断时重跑会从剩余超限消息继续。
            await remove_messages_with_attachments(db, old_ids)

        await _trim_old_interactions(db, session_id)
