"""按 session baseline 读取连续对话历史。

读取阶段只应用 baseline 水位和非 token 的条数安全上限；不做本地 token 估算，
也不推进 baseline。预算、压缩和重试统一在 provider 请求边界处理。
"""
from __future__ import annotations

from collections.abc import Iterable
from contextvars import ContextVar
from typing import Any

from sqlalchemy import select

from .tokens import HISTORY_MAX_MSGS


_last_history_stats: ContextVar[dict[str, Any] | None] = ContextVar(
    "session_history_stats", default=None,
)


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
    """按条数保留最近历史，兼容旧调用但不做本地 token 估算。

    上下文是否超预算只能由 provider 的实际请求结果决定。``token_budget`` 保留
    仅为兼容旧调用，绝不参与历史选择。
    """
    newest = list(messages_newest_first)[:max_messages]
    chronological = list(reversed(newest))
    # 兼容旧显式调用：将 token_budget 视作“字符安全上限”，不做 token 换算。
    # 正常历史读取不会调用本函数。
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
    used_chars = 0
    for unit in reversed(units):
        chars = sum(len(getattr(message, "content", "") or "") for message in unit)
        if selected and used_chars + chars > max(1, int(token_budget)):
            break
        selected[0:0] = unit
        used_chars += chars
    return selected

async def load_session_history(
    db,
    session_id: int,
    baseline_message_id: int = 0,
    *,
    budget: object | None = None,
    token_budget: int | None = None,
    max_messages: int = HISTORY_MAX_MSGS,
) -> list:
    """读取 baseline 之后的历史，按数据库消息 id 正序返回。

    读取窗口只保护当前 run，不推进 baseline。持久化 baseline 更新由
    ``compress_conv`` 负责；summary 行始终保留在结果第一条，由 history builder
    在发送边界规范化为普通 user 历史消息。
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
    # 不在数据库读取阶段使用本地 token 估算。历史只受非 token 的条数安全上限
    # 保护；真正的预算、压缩和重试统一由 provider 边界处理。
    history = list(reversed(newest))
    _last_history_stats.set({
        "history_loaded_count": len(newest),
        "history_selected_count": len(history) + len(summary),
        "history_selected_tokens": None,
        "history_token_budget": None,
        "history_selection": "provider-authoritative",
        "history_summary_count": len(summary),
        "history_baseline_message_id": int(baseline_message_id or 0),
        "history_oldest_selected_id": getattr(history[0], "id", None) if history else None,
        "history_newest_selected_id": getattr(history[-1], "id", None) if history else None,
    })
    return summary + history


def consume_history_stats() -> dict[str, Any] | None:
    """取出当前任务最近一次历史窗口统计，不携带正文。"""
    stats = _last_history_stats.get()
    _last_history_stats.set(None)
    return stats
