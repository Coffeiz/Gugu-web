"""上下文预算分项与 provider 溢出后的确定性兜底。

正常请求不使用本地 token 估算决定压缩；provider 的实际响应是预算触发的权威来源。
本模块只保留统一分项诊断，以及 provider 溢出后摘要失败时的本地截断兜底，避免
错误信息再次触发同一上游请求。
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Iterable

from .tokens import estimate_tokens, message_text


SAFE_BUDGET_RATIO = 0.90
TRUNCATION_RATIO = 0.95
RECENT_MESSAGE_FALLBACK_COUNT = 20
FALLBACK_RECENT_CHARS = 20_000


@dataclass(frozen=True)
class ContextBudget:
    """一次模型请求的唯一预算计划。

    这是 provider 边界的配置/诊断结构，不参与数据库历史读取。``history_tokens``
    只用于记录 provider 返回的实际分项或兼容诊断；入口不得用本地估算值决定
    历史窗口、压缩触发或重试。
    """

    model_context_tokens: int
    tool_schema_tokens: int = 0
    dynamic_tail_tokens: int = 0
    current_turn_tokens: int = 0
    output_reserve_tokens: int = 0
    provider_overhead_tokens: int = 0
    history_tokens: int = 0
    system_prompt_tokens: int = 0
    snapshot_tokens: int = 0
    soft_ratio: float = SAFE_BUDGET_RATIO
    compression_ratio: float = 0.50

    @classmethod
    def for_history(
        cls,
        model_context_tokens: int,
        *,
        fixed_prefix_text: str = "",
        tool_schema_tokens: int = 0,
        dynamic_tail_tokens: int = 0,
        current_turn_tokens: int = 0,
        output_reserve_tokens: int = 0,
        provider_overhead_tokens: int = 0,
    ) -> "ContextBudget":
        """兼容旧调用的配置对象；仅用于诊断，不再驱动历史读取。"""
        return cls(
            model_context_tokens=max(1, int(model_context_tokens or 0)),
            tool_schema_tokens=max(0, int(tool_schema_tokens or 0)),
            dynamic_tail_tokens=max(0, int(dynamic_tail_tokens or 0)),
            current_turn_tokens=max(0, int(current_turn_tokens or 0)),
            output_reserve_tokens=max(0, int(output_reserve_tokens or 0)),
            provider_overhead_tokens=max(0, int(provider_overhead_tokens or 0)),
            # 保留旧诊断字段，调用方不得用它做历史选择或压缩触发。
            system_prompt_tokens=estimate_tokens(fixed_prefix_text),
        )

    @classmethod
    def from_messages(
        cls,
        model_context_tokens: int,
        messages: Iterable[dict],
        *,
        system_text: str = "",
        fixed_prefix_size: int = 0,
        tool_schema_tokens: int = 0,
        dynamic_tail_tokens: int = 0,
        current_turn_tokens: int = 0,
        output_reserve_tokens: int = 0,
        provider_overhead_tokens: int = 0,
    ) -> "ContextBudget":
        """从已组装消息生成唯一预算分解。

        ``messages`` 只传一次：固定前缀单独计入 snapshot，剩余部分计入
        history；system、工具 schema 和 dynamic tail 不再由调用方重复相加。
        """
        items = list(messages)
        prefix_size = max(0, min(int(fixed_prefix_size or 0), len(items)))
        snapshot_tokens = sum(
            estimate_tokens(message_text(item)) for item in items[:prefix_size]
        )
        history_tokens = sum(
            estimate_tokens(message_text(item)) for item in items[prefix_size:]
        )
        return cls.from_parts(
            model_context_tokens=max(1, int(model_context_tokens or 0)),
            tool_schema_tokens=max(0, int(tool_schema_tokens or 0)),
            dynamic_tail_tokens=max(0, int(dynamic_tail_tokens or 0)),
            current_turn_tokens=max(0, int(current_turn_tokens or 0)),
            output_reserve_tokens=max(0, int(output_reserve_tokens or 0)),
            provider_overhead_tokens=max(0, int(provider_overhead_tokens or 0)),
            history_tokens=max(0, int(history_tokens)),
            system_prompt_tokens=estimate_tokens(system_text),
            snapshot_tokens=max(0, int(snapshot_tokens)),
        )

    @classmethod
    def from_parts(
        cls,
        model_context_tokens: int,
        *,
        system_prompt_tokens: int = 0,
        snapshot_tokens: int = 0,
        history_tokens: int = 0,
        tool_schema_tokens: int = 0,
        dynamic_tail_tokens: int = 0,
        current_turn_tokens: int = 0,
        output_reserve_tokens: int = 0,
        provider_overhead_tokens: int = 0,
    ) -> "ContextBudget":
        """用同一口径的分项 token 数创建预算，避免再次合计。"""
        return cls(
            model_context_tokens=max(1, int(model_context_tokens or 0)),
            tool_schema_tokens=max(0, int(tool_schema_tokens or 0)),
            dynamic_tail_tokens=max(0, int(dynamic_tail_tokens or 0)),
            current_turn_tokens=max(0, int(current_turn_tokens or 0)),
            output_reserve_tokens=max(0, int(output_reserve_tokens or 0)),
            provider_overhead_tokens=max(0, int(provider_overhead_tokens or 0)),
            history_tokens=max(0, int(history_tokens or 0)),
            system_prompt_tokens=max(0, int(system_prompt_tokens or 0)),
            snapshot_tokens=max(0, int(snapshot_tokens or 0)),
        )

    @property
    def non_history_tokens(self) -> int:
        return (
            self.system_prompt_tokens
            + self.snapshot_tokens
            + self.tool_schema_tokens
            + self.dynamic_tail_tokens
            + self.current_turn_tokens
            + self.output_reserve_tokens
            + self.provider_overhead_tokens
        )

    @property
    def total_tokens(self) -> int:
        return self.non_history_tokens + max(0, self.history_tokens)

    @property
    def soft_limit_tokens(self) -> int:
        ratio = min(0.95, max(0.5, float(self.soft_ratio)))
        return max(1, int(self.model_context_tokens * ratio))

    @property
    def compression_cap_tokens(self) -> int:
        ratio = min(0.5, max(0.0, float(self.compression_ratio)))
        return max(1, int(self.model_context_tokens * ratio))

    @property
    def truncation_limit_tokens(self) -> int:
        """确定性保护上限，保留 5% 给 provider/估算误差。"""
        return max(1, int(self.model_context_tokens * TRUNCATION_RATIO))

    @property
    def history_capacity_tokens(self) -> int:
        """兼容诊断字段；不得用于历史读取。"""
        return max(0, self.soft_limit_tokens - self.non_history_tokens)

    @property
    def hard_history_capacity_tokens(self) -> int:
        """兼容诊断字段；provider overflow 兜底不使用它。"""
        return max(0, self.truncation_limit_tokens - self.non_history_tokens)

    def with_history(self, history_tokens: int) -> "ContextBudget":
        return ContextBudget(
            model_context_tokens=self.model_context_tokens,
            tool_schema_tokens=self.tool_schema_tokens,
            dynamic_tail_tokens=self.dynamic_tail_tokens,
            current_turn_tokens=self.current_turn_tokens,
            output_reserve_tokens=self.output_reserve_tokens,
            provider_overhead_tokens=self.provider_overhead_tokens,
            history_tokens=max(0, int(history_tokens or 0)),
            soft_ratio=self.soft_ratio,
            compression_ratio=self.compression_ratio,
            system_prompt_tokens=self.system_prompt_tokens,
            snapshot_tokens=self.snapshot_tokens,
        )

    def diagnostics(self) -> dict[str, int | float]:
        """返回可安全写入诊断日志的数字字段，不包含上下文正文。"""
        return {
            "model_context_tokens": self.model_context_tokens,
            "system_prompt_tokens": self.system_prompt_tokens,
            "snapshot_tokens": self.snapshot_tokens,
            "tool_schema_tokens": self.tool_schema_tokens,
            "dynamic_tail_tokens": self.dynamic_tail_tokens,
            "current_turn_tokens": self.current_turn_tokens,
            "output_reserve_tokens": self.output_reserve_tokens,
            "provider_overhead_tokens": self.provider_overhead_tokens,
            "history_tokens": self.history_tokens,
            "total_tokens": self.total_tokens,
            "soft_limit_tokens": self.soft_limit_tokens,
            "truncation_limit_tokens": self.truncation_limit_tokens,
            "compression_cap_tokens": self.compression_cap_tokens,
            "history_capacity_tokens": self.history_capacity_tokens,
        }


@dataclass(frozen=True)
class BudgetResult:
    changed: bool
    before_tokens: int
    after_tokens: int
    dropped_messages: int
    oversized_item: bool = False


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
    target_ratio: float | None = None,
    overhead_tokens: int = 0,
    extra_tokens: int = 0,
    protected_from: int | None = None,
) -> tuple[list[dict], BudgetResult]:
    """在不调用 LLM 的前提下截断消息，返回新列表和统计结果。

    固定前缀和最新完整工具单元优先保留；其余从最旧单元开始丢弃。
    """
    original = list(messages)
    extra_tokens = max(0, int(extra_tokens or 0))
    budget = ContextBudget.from_messages(
        max(1, int(context_tokens or 0)),
        original,
        system_text=system_text,
        fixed_prefix_size=fixed_prefix_size,
        provider_overhead_tokens=overhead_tokens,
        dynamic_tail_tokens=extra_tokens,
    )
    before = budget.total_tokens
    safe_budget = budget.truncation_limit_tokens
    if before <= safe_budget:
        return original, BudgetResult(False, before, before, 0)

    prefix_size = max(0, min(int(fixed_prefix_size), len(original)))
    prefix = original[:prefix_size]
    body = original[prefix_size:]
    protected_tail: list[dict] = []
    if protected_from is not None:
        protected_relative = max(0, int(protected_from) - prefix_size)
        protected_tail = body[protected_relative:]
        body = body[:protected_relative]
    target = budget.compression_cap_tokens
    if target_ratio is not None:
        # 仅允许调用方进一步收紧上限，不允许恢复超过 50% 的旧目标。
        ratio = min(0.5, max(0.0, float(target_ratio)))
        target = max(1, int(budget.model_context_tokens * ratio))
    fixed_tokens = extra_tokens + estimate_tokens(system_text) + sum(
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
    after = ContextBudget.from_messages(
        budget.model_context_tokens,
        result,
        system_text=system_text,
        fixed_prefix_size=prefix_size,
        provider_overhead_tokens=overhead_tokens,
        dynamic_tail_tokens=extra_tokens,
    ).total_tokens
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
    dynamic_tail_tokens = sum(
        estimate_tokens(message_text(message))
        for message in getattr(messages, "dynamic_tail", ())
    )
    truncated, result = truncate_messages(
        conversation,
        system_text,
        context_tokens,
        fixed_prefix_size=getattr(messages, "fixed_prefix_size", 0),
        overhead_tokens=overhead_tokens,
        extra_tokens=dynamic_tail_tokens,
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


def enforce_provider_overflow_fallback(
    messages,
    system_text: str = "",
    context_tokens: int = 0,
    *,
    protected_from: int | None = None,
) -> BudgetResult:
    """provider 已明确返回超窗后的无估算兜底。

    这里不把 context_tokens 转换成 token/字符比例，也不估算 system、工具 schema
    或动态尾部；只按完整工具单元保留最近消息，并限制最近正文的字符数。它仅在
    provider overflow 且 LLM 压缩无结果时执行，正常请求不会经过此路径。
    """
    conversation = list(getattr(messages, "conversation", messages))
    prefix_size = max(0, min(int(getattr(messages, "fixed_prefix_size", 0) or 0), len(conversation)))
    prefix = conversation[:prefix_size]
    body = conversation[prefix_size:]
    protected_tail: list[dict] = []
    if protected_from is not None:
        relative = max(0, int(protected_from) - prefix_size)
        protected_tail = body[relative:]
        body = body[:relative]

    units = _units(body)
    kept_units: list[list[dict]] = []
    kept_chars = 0
    kept_count = 0
    for unit in reversed(units):
        unit_messages = [body[index] for index in unit]
        unit_chars = sum(len(message_text(item)) for item in unit_messages)
        if kept_units and (kept_count + len(unit_messages) > RECENT_MESSAGE_FALLBACK_COUNT
                           or kept_chars + unit_chars > FALLBACK_RECENT_CHARS):
            break
        kept_units.append(unit_messages)
        kept_chars += unit_chars
        kept_count += len(unit_messages)
    kept_units.reverse()
    kept = [item for unit in kept_units for item in unit]
    result = prefix + kept + protected_tail
    changed = len(result) < len(conversation)
    oversized = False
    if not changed and result:
        # 单条巨大消息也必须能退出 overflow 重试；只裁正文，不改工具结构。
        latest = result[-1]
        if isinstance(latest, dict) and isinstance(latest.get("content"), str):
            text = latest["content"]
            if len(text) > FALLBACK_RECENT_CHARS:
                copy = dict(latest)
                copy["content"] = text[:FALLBACK_RECENT_CHARS] + "\n[内容因 provider 超窗被截断]"
                result[-1] = copy
                changed = True
                oversized = True
    if not changed:
        return BudgetResult(False, 0, 0, 0, oversized_item=oversized)
    replace = getattr(messages, "replace_conversation", None)
    if replace is not None:
        replace(result)
    else:
        messages[:] = result
    return BudgetResult(True, 0, 0, max(0, len(conversation) - len(result)), oversized_item=oversized)


def is_context_overflow_error(error: BaseException) -> bool:
    """只识别明确的上下文超量错误，不把普通 API 错误误当成可重试。"""
    text = f"{type(error).__name__}:{error}".lower()
    return "request_too_large" in text or "context_length_exceeded" in text or "413" in text
