"""按 session baseline 读取连续对话历史。

历史读取窗口是运行时的安全边界；它不推进 baseline，也不替代持久化压缩。
"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select

from .budget import effective_budget
from .tokens import HISTORY_MAX_MSGS, HISTORY_TOKEN_BUDGET, estimate_tokens, msg_tokens


def history_budget_for_context(
    context_tokens: int,
    *,
    system_prompt: str = "",
    snapshot_context: str = "",
    reserve_ratio: float = 0.20,
) -> int:
    """计算历史窗口预算，不改变持久化压缩的 token 配置。

    读取阶段尚未完成工具 schema 和动态尾部组装，因此额外预留一段固定比例，
    防止 baseline=0 的长会话把 system/snapshot/工具上下文挤出模型窗口。
    """
    context = max(1, int(context_tokens or HISTORY_TOKEN_BUDGET))
    fixed_tokens = estimate_tokens(system_prompt) + estimate_tokens(snapshot_context)
    dynamic_reserve = int(context * max(0.0, min(0.40, reserve_ratio)))
    return max(1, effective_budget(context, reserved_tokens=fixed_tokens + dynamic_reserve))


def _blocks(message) -> list[dict]:
    value = getattr(message, "content_json", None)
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    return []


def _has_tool_call(message) -> bool:
    return any(block.get("type") in {"tool_call", "tool_use"} for block in _blocks(message))


def _has_tool_result(message) -> bool:
    return getattr(message, "role", None) == "tool" or any(
        block.get("type") == "tool_result" for block in _blocks(message)
    )


def select_history_window(
    messages_newest_first: Iterable,
    *,
    token_budget: int,
    max_messages: int = HISTORY_MAX_MSGS,
) -> list:
    """按 token 预算选择最近历史，并保持工具调用轮次完整。

    ``messages_newest_first`` 不包含 summary；调用方负责把 summary 置于结果最前。
    """
    newest = list(messages_newest_first)[:max_messages]
    chronological = list(reversed(newest))
    units: list[list] = []
    index = 0
    while index < len(chronological):
        unit = [chronological[index]]
        if _has_tool_call(chronological[index]):
            next_index = index + 1
            while next_index < len(chronological) and _has_tool_result(chronological[next_index]):
                unit.append(chronological[next_index])
                next_index += 1
            index = next_index
        else:
            index += 1
        units.append(unit)

    selected: list = []
    used = 0
    for unit in reversed(units):
        unit_tokens = sum(msg_tokens(message) for message in unit)
        if selected and used + unit_tokens > max(1, int(token_budget)):
            break
        selected[0:0] = unit
        used += unit_tokens
    return selected

async def load_session_history(
    db,
    session_id: int,
    baseline_message_id: int = 0,
    *,
    token_budget: int = HISTORY_TOKEN_BUDGET,
    max_messages: int = HISTORY_MAX_MSGS,
) -> list:
    """读取 baseline 之后的有限历史，按数据库消息 id 正序返回。

    读取窗口只保护当前 run，不推进 baseline。持久化压缩仍由 ``compress_conv``
    负责；summary 行始终保留给入口层弹出并放入固定上下文区。
    """
    from app.models import ConversationMessage

    summary_query = (
        select(ConversationMessage)
        .where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role == "summary",
        )
        .order_by(ConversationMessage.id.desc())
        .limit(1)
    )
    summary = list((await db.execute(summary_query)).scalars().all())

    query = (
        select(ConversationMessage)
        .where(
            ConversationMessage.session_id == session_id,
            ConversationMessage.role != "summary",
        )
        .order_by(ConversationMessage.id.desc())
        .limit(max(1, int(max_messages)))
    )
    if baseline_message_id > 0:
        query = query.where(
            ConversationMessage.id > baseline_message_id
        )
    newest = list((await db.execute(query)).scalars().all())
    history = select_history_window(
        newest,
        token_budget=token_budget,
        max_messages=max_messages,
    )
    return summary + history
