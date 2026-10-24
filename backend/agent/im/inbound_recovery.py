"""IM 入站执行收据和展示检查点；进程退出后不自动重做已开始的操作。"""
from __future__ import annotations

from hashlib import sha256

from sqlalchemy import select

from app.models import ConversationMessage
from agent.context.display_checkpoint import display_run_key


def receipt_key(message_id: str) -> str:
    return f"im:started:{message_id}"


async def register_batch(redis, message_ids: list[str]) -> str:
    """执行前固定本批身份；未 ACK 的收据不设过期，避免长任务被当成新消息。"""
    key = sha256("\n".join(sorted(message_ids)).encode()).hexdigest()
    await redis.mset({receipt_key(mid): key for mid in message_ids})
    return key


def user_run_key(batch_key: str) -> str:
    return f"im-inbound:{batch_key}"


async def recover_started(session_factory, batch_key: str) -> bool:
    """找到已开始的持久化请求即停止重放；未落库的准备阶段允许重新消费。"""
    from agent.context.display_timeline import finalize_display_timeline
    from app.services.conversation_run_outcomes import build_run_outcome

    async with session_factory() as db:
        user = (await db.execute(select(ConversationMessage).where(
            ConversationMessage.role == "user",
            ConversationMessage.run_id == user_run_key(batch_key),
        ))).scalars().first()
        if user is None:
            return False
        completed = (await db.execute(select(ConversationMessage.id).where(
            ConversationMessage.session_id == user.session_id,
            ConversationMessage.role == "assistant",
            ConversationMessage.content_json.is_(None),
            ConversationMessage.display_timeline[0]["anchorMessageId"].as_integer() == user.id,
        ).limit(1))).scalar_one_or_none()
        if completed is not None:
            return True
        checkpoint = (await db.execute(select(ConversationMessage).where(
            ConversationMessage.session_id == user.session_id,
            ConversationMessage.role == "assistant",
            ConversationMessage.run_id == display_run_key(user.id),
        ))).scalars().first()
        # 正常完成的展示行已转为普通正文行；只缺 ACK 时直接确认，不改成中断。
        if checkpoint is None or checkpoint.content_json is not None:
            user.run_outcome = build_run_outcome(status="interrupted", run_id=user.run_id)
            if checkpoint is not None:
                checkpoint.display_timeline = finalize_display_timeline(
                    checkpoint.display_timeline or [])
            await db.commit()
        return True
