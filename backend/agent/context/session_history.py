"""按 session baseline 读取连续对话历史。"""
from __future__ import annotations

from sqlalchemy import select


async def load_session_history(
    db,
    session_id: int,
    baseline_message_id: int = 0,
) -> list:
    """读取当前 baseline 之后的全部历史，按数据库消息 id 正序返回。

    未压缩 session 的 baseline 为 0，因此首次建立的历史不会因为“最近 N 条”窗口
    滑动而改变前缀。压缩完成后，旧消息仍保留在数据库里，只从新的 watermark 之后
    继续追加；summary 行始终保留给入口层弹出并放入固定上下文区。
    """
    from app.models import ConversationMessage

    query = (
        select(ConversationMessage)
        .where(ConversationMessage.session_id == session_id)
        .order_by(ConversationMessage.id.asc())
    )
    if baseline_message_id > 0:
        query = query.where(
            (ConversationMessage.id > baseline_message_id)
            | (ConversationMessage.role == "summary")
        )
    return list((await db.execute(query)).scalars().all())
