"""按 session baseline 读取连续对话历史。"""
from __future__ import annotations

from sqlalchemy import select


async def load_session_history(
    db,
    session_id: int,
    baseline_message_id: int = 0,
    *,
    context_tokens: int | None = None,
    session=None,
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
    rows = list((await db.execute(query)).scalars().all())
    if context_tokens:
        rows = _apply_history_budget(rows, context_tokens, session=session)
    return rows


def _apply_history_budget(rows: list, context_tokens: int, *, session=None) -> list:
    """历史本身超安全预算时做本地截断并推进 baseline。

    这是请求前的确定性自救，不调用 LLM。正常低于预算的历史保持原样，避免把
    合法的长上下文误当成需要整理的内容。
    """
    from agent.context.budget import atomic_message_units, effective_budget
    from agent.context.tokens import estimate_tokens, message_text, msg_tokens

    summary = [row for row in rows if getattr(row, "role", None) == "summary"]
    normal = [row for row in rows if getattr(row, "role", None) != "summary"]
    total = sum(msg_tokens(row) for row in normal)
    if total <= effective_budget(context_tokens):
        return rows

    body = [{
        "role": getattr(row, "role", ""),
        "content": getattr(row, "content_json", None)
        if getattr(row, "content_json", None) is not None
        else getattr(row, "content", "") or "",
    } for row in normal]
    target = max(1, int(context_tokens * 0.2))
    kept_indices: list[int] = []
    used = 0
    units = atomic_message_units(body)
    for unit in reversed(units):
        unit_tokens = sum(estimate_tokens(message_text(body[index])) for index in unit)
        if kept_indices and used + unit_tokens > target:
            break
        kept_indices.extend(unit)
        used += unit_tokens
    kept_indices.sort()
    kept_set = set(kept_indices)
    dropped = [row for index, row in enumerate(normal) if index not in kept_set]
    if dropped and session is not None:
        session.baseline_message_id = max(int(row.id) for row in dropped)
    kept = [row for index, row in enumerate(normal) if index in kept_set]
    return summary + kept
