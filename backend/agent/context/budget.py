"""上下文预算的确定性预检与强制截断。

这里故意不调用 LLM。请求已经超量或上游返回 413 时，必须先用本地规则把
消息压到安全范围，避免依赖另一次同样可能超量的摘要请求。
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Iterable

from .tokens import estimate_tokens, message_text


SAFE_BUDGET_RATIO = 0.90
# run 完成后的后台 checkpoint 阈值；运行中的 provider 预检仍使用硬预算。
POST_RUN_CHECKPOINT_RATIO = 0.90
HARD_TARGET_RATIO = 0.20
MAX_RETRY_COUNT = 1
RECENT_MESSAGE_FALLBACK_COUNT = 20


@dataclass(frozen=True)
class BudgetResult:
    changed: bool
    before_tokens: int
    after_tokens: int
    dropped_messages: int
    oversized_item: bool = False


def effective_budget(
    context_tokens: int,
    *,
    safety_ratio: float = SAFE_BUDGET_RATIO,
    reserved_tokens: int = 0,
) -> int:
    """返回 system + history 可用的安全预算。

    ``reserved_tokens`` 预留给 provider 工具 schema 和模型输出，避免只按
    conversation 估算后仍把超大的完整请求发送给模型。
    """
    value = max(1, int(context_tokens or 0) - max(0, int(reserved_tokens or 0)))
    ratio = min(0.95, max(0.5, float(safety_ratio)))
    return max(1, int(value * ratio))


def estimate_tool_schema_tokens(tools) -> int:
    """估算本轮工具 schema 大小，不记录工具定义内容。"""
    if not tools:
        return 0
    try:
        payload = json.dumps(tools, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        payload = str(tools)
    return estimate_tokens(payload)


def _blocks(message: dict) -> list[dict]:
    content = message.get("content")
    if isinstance(content, list):
        return [item for item in content if isinstance(item, dict)]
    if isinstance(content, dict):
        return [content]
    return []


def _has_tool_call(message: dict) -> bool:
    return bool(message.get("tool_calls")) or any(
        block.get("type") in {"tool_use", "tool_call"} for block in _blocks(message)
    )


def _has_tool_result(message: dict) -> bool:
    return message.get("role") == "tool" or any(
        block.get("type") == "tool_result" for block in _blocks(message)
    )


def _units(messages: list[dict]) -> list[list[int]]:
    """按完整工具往返切分，避免截出孤立 tool_result。"""
    result: list[list[int]] = []
    index = 0
    while index < len(messages):
        unit = [index]
        if _has_tool_call(messages[index]):
            next_index = index + 1
            while next_index < len(messages) and _has_tool_result(messages[next_index]):
                unit.append(next_index)
                next_index += 1
            index = next_index
        else:
            index += 1
        result.append(unit)
    return result


def atomic_message_units(messages: list[dict]) -> list[list[int]]:
    """返回消息的原子组索引，供数据库历史截断复用。"""
    return _units(messages)


def _truncate_text(value: str, max_tokens: int) -> str:
    if estimate_tokens(value) <= max_tokens:
        return value
    # 估算器是单调的，二分得到不超过目标的前缀，保留确定性和 O(log n) 复杂度。
    marker = "\n[内容因上下文预算被截断]"
    prefix_budget = max(1, max_tokens - estimate_tokens(marker))
    low, high = 0, len(value)
    while low < high:
        middle = (low + high + 1) // 2
        if estimate_tokens(value[:middle]) <= prefix_budget:
            low = middle
        else:
            high = middle - 1
    return value[:low] + marker


def _truncate_value(value, max_tokens: int):
    if isinstance(value, str):
        return _truncate_text(value, max_tokens)
    if isinstance(value, list):
        return [_truncate_value(item, max_tokens) for item in value]
    if isinstance(value, dict):
        return {key: _truncate_value(item, max_tokens) for key, item in value.items()}
    return value


def _fit_oversized_message(message: dict, max_tokens: int) -> dict:
    copy = dict(message)
    if "content" in copy:
        copy["content"] = _truncate_value(copy["content"], max_tokens)
    if "reasoning_content" in copy:
        copy["reasoning_content"] = _truncate_text(str(copy["reasoning_content"]), max_tokens)
    if "tool_calls" in copy:
        copy["tool_calls"] = _truncate_value(copy["tool_calls"], max_tokens)
    return copy


def truncate_messages(
    messages: Iterable[dict],
    system_text: str = "",
    context_tokens: int = 0,
    *,
    fixed_prefix_size: int = 0,
    target_ratio: float = HARD_TARGET_RATIO,
    overhead_tokens: int = 0,
    protected_from: int | None = None,
) -> tuple[list[dict], BudgetResult]:
    """在不调用 LLM 的前提下截断消息，返回新列表和统计结果。

    固定前缀和最新完整工具单元优先保留；其余从最旧单元开始丢弃。
    """
    original = list(messages)
    before = overhead_tokens + estimate_tokens(system_text) + sum(
        estimate_tokens(message_text(message)) for message in original
    )
    safe_budget = effective_budget(context_tokens, reserved_tokens=overhead_tokens)
    if before - overhead_tokens <= safe_budget:
        return original, BudgetResult(False, before, before, 0)

    prefix_size = max(0, min(int(fixed_prefix_size), len(original)))
    prefix = original[:prefix_size]
    body = original[prefix_size:]
    protected_tail: list[dict] = []
    if protected_from is not None:
        protected_relative = max(0, int(protected_from) - prefix_size)
        protected_tail = body[protected_relative:]
        body = body[:protected_relative]
    target = max(1, int(max(0.1, min(0.5, target_ratio)) * max(
        1, int(context_tokens) - max(0, int(overhead_tokens))
    )))
    fixed_tokens = estimate_tokens(system_text) + sum(
        estimate_tokens(message_text(message)) for message in prefix
    )
    fixed_tokens += sum(estimate_tokens(message_text(message)) for message in protected_tail)

    # LLM 压缩失败或压缩请求本身超限时，先保留最近 20 条完整消息。
    # 只有这段仍放不进安全预算，才进入下面更激进的 token 截断。
    recent_units: list[list[dict]] = []
    recent_count = 0
    for unit in reversed(_units(body)):
        recent_units.append([body[index] for index in unit])
        recent_count += len(unit)
        if recent_count >= RECENT_MESSAGE_FALLBACK_COUNT:
            break
    recent_units.reverse()
    recent = [message for unit in recent_units for message in unit]
    recent_total = fixed_tokens + sum(estimate_tokens(message_text(message)) for message in recent)
    if recent and recent_total <= safe_budget:
        return prefix + recent + protected_tail, BudgetResult(
            True,
            before,
            recent_total,
            max(0, len(original) - len(prefix) - len(recent)),
        )

    available = max(1, min(safe_budget - fixed_tokens, target - fixed_tokens))

    kept: list[list[dict]] = []
    used = 0
    units = _units(body)
    for unit in reversed(units):
        unit_messages = [body[index] for index in unit]
        unit_tokens = sum(estimate_tokens(message_text(message)) for message in unit_messages)
        if not kept and unit_tokens > available:
            # 最新单元单独处理：不能用原样超大消息绕过字段级截断。
            break
        if kept and used + unit_tokens > available:
            break
        kept.append(unit_messages)
        used += unit_tokens
    kept.reverse()

    # 最新单元必须存在；若它自身过大，做字段级确定性截断，而不是无限重试。
    oversized = False
    if not kept and units:
        latest = [body[index] for index in units[-1]]
        latest_budget = max(1, available)
        oversized = sum(estimate_tokens(message_text(message)) for message in latest) > latest_budget
        kept = [[_fit_oversized_message(message, latest_budget) for message in latest]]

    result = prefix + [message for unit in kept for message in unit] + protected_tail
    after = overhead_tokens + estimate_tokens(system_text) + sum(
        estimate_tokens(message_text(message)) for message in result
    )
    dropped = max(0, len(original) - len(result))
    return result, BudgetResult(True, before, after, dropped, oversized_item=oversized)


def enforce_message_budget(
    messages,
    system_text: str,
    context_tokens: int,
    *,
    overhead_tokens: int = 0,
    protected_from: int | None = None,
) -> BudgetResult:
    """就地应用强制截断，兼容 PromptMessages 的动态尾部。"""
    conversation = list(getattr(messages, "conversation", messages))
    truncated, result = truncate_messages(
        conversation,
        system_text,
        context_tokens,
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
        overhead_tokens=overhead_tokens,
        protected_from=protected_from,
    )
    if not result.changed:
        return result
    replace = getattr(messages, "replace_conversation", None)
    if replace is not None:
        replace(truncated)
    else:
        messages[:] = truncated
    return result


def is_context_overflow_error(error: BaseException) -> bool:
    """只识别明确的上下文超量错误，不把普通 API 错误误当成可重试。"""
    text = f"{type(error).__name__}:{error}".lower()
    return "request_too_large" in text or "context_length_exceeded" in text or "413" in text
