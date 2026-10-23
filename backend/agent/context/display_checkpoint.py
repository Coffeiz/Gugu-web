"""展示检查点：Web/IM 共用的增量持久化，不进入模型历史。"""
from __future__ import annotations

from sqlalchemy import select

from app.models import ConversationMessage


def display_run_key(user_message_id: int) -> str:
    return f"display-user:{user_message_id}"


def checkpoint_callback(request, execution):
    """所有真实输入共用展示检查点，不把它放入模型历史。"""
    if not request.user_message_id:
        return None

    async def checkpoint(items):
        await save_checkpoint(execution.session_factory, execution.session_id,
                              items, request.user_message_id)

    return checkpoint


async def save_checkpoint(session_factory, session_id: int, items: list[dict], user_message_id: int) -> None:
    """只保存可展示事件，不复制媒体正文，也不把检查点放入模型历史。"""
    from agent.media.images import strip_image_for_history

    cleaned = strip_image_for_history(items)
    from agent.outbound import sanitize_outbound
    for item in cleaned:
        if item.get("kind") == "assistant" and item.get("text"):
            item["text"] = sanitize_outbound(item["text"])
    timeline = cleaned
    async with session_factory() as db:
        row = (await db.execute(select(ConversationMessage).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "assistant",
            ConversationMessage.run_id == display_run_key(user_message_id),
        ))).scalars().first()
        if row is None:
            row = ConversationMessage(session_id=session_id, role="assistant", content="",
                                      content_json=[], run_id=display_run_key(user_message_id))
            db.add(row)
        row.display_timeline = timeline
        await db.commit()


async def seal_checkpoint(session_factory, session_id: int, user_message_id: int) -> None:
    """失败/中断也提交展示终态，不把部分执行写成成功的模型历史。"""
    from sqlalchemy import null
    from agent.context.display_timeline import finalize_display_timeline

    async with session_factory() as db:
        row = (await db.execute(select(ConversationMessage).where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.run_id == display_run_key(user_message_id),
        ))).scalars().first()
        if row is None:
            return
        items = finalize_display_timeline(row.display_timeline or [])
        row.display_timeline = items
        row.content_json = null()
        if items:
            row.run_id = items[0]['runId']
        await db.commit()
