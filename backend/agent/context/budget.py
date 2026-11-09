"""Provider 上下文超限识别与按完整消息单元恢复。"""
from __future__ import annotations

from dataclasses import dataclass

from .retention import protected_unit_offset


SAFE_BUDGET_RATIO = 0.85

# 上游「输入上下文超限」的文案特征。用于**判定**：命中就走压缩重试
# （is_context_overflow_error）。清单偏宽，因为其中包含 413 体量语义——请求体过大
# 时确定性截断仍然有效，压缩重试就算无效也还有截断兜底。
CONTEXT_OVERFLOW_PHRASES = (
    "maximum context length", "context window exceeded", "context length exceeded",
    "context window exceeds limit",
    "input token count exceeds", "prompt is too long", "input is too long",
    "request entity too large", "request too large",
)

# 明确指向**模型上下文窗口**超限的文案特征。用于**给用户定性**（provider 侧的
# 错误摘要与前端文案）：只有这些措辞才说「上下文超限」。「request too large」
# 这类 413 体量语义不在其中，否则会把「请求体过大」说成「上下文超限」。
CONTEXT_WINDOW_OVERFLOW_PHRASES = (
    "maximum context length", "context window exceeded", "context length exceeded",
    "context window exceeds limit", "input token count exceeds",
)


@dataclass(frozen=True)
class BudgetResult:
    changed: bool
    dropped_messages: int
    protected_start_index: int | None = None
    anchor_index: int | None = None
    protected_source_start_index: int | None = None
    previous_protected_start_index: int | None = None


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


def _consecutive_tool_result_indices(messages: list[dict], start: int) -> list[int]:
    """返回紧随工具调用的连续结果消息下标，结果必须留在同一个原子组中。"""
    indices: list[int] = []
    while start < len(messages) and _has_tool_result(messages[start]):
        indices.append(start)
        start += 1
    return indices


def _units(messages: list[dict]) -> list[list[int]]:
    """按完整工具往返切分，避免截出孤立 tool_result。"""
    result: list[list[int]] = []
    index = 0
    while index < len(messages):
        unit = [index]
        if _has_tool_call(messages[index]):
            result_indices = _consecutive_tool_result_indices(messages, index + 1)
            unit.extend(result_indices)
            index = result_indices[-1] + 1 if result_indices else index + 1
        else:
            index += 1
        result.append(unit)
    return result


def atomic_message_units(messages: list[dict]) -> list[list[int]]:
    """返回消息的原子组索引，供数据库历史截断复用。"""
    return _units(messages)


def enforce_provider_overflow_fallback(
    messages,
    *,
    protected_from: int | None = None,
    protected_anchor_index: int | None = None,
    protected_previous_from: int | None = None,
) -> BudgetResult:
    """provider 已明确返回超窗后的无估算兜底。

    保留固定前缀、已有摘要、当前用户锚点和最新完整工具往返。
    缩窗后只尝试一次，是否能容纳由 Provider 决定。
    """
    from agent.context.assembly.area import MessageArea
    if not isinstance(messages, MessageArea):
        raise TypeError("Provider overflow 截断只接受 MessageArea")
    conversation = messages.provider_projection().to_messages()
    prefix_size = max(0, min(int(messages.fixed_prefix_size or 0), len(conversation)))
    prefix = conversation[:prefix_size]
    body = conversation[prefix_size:]
    protected_tail: list[dict] = []
    previous_protected_tail: list[dict] = []
    anchor_message = None
    anchor_body_index = None
    relative = len(body)
    if protected_from is not None:
        relative = max(0, int(protected_from) - prefix_size)
        protected_tail = body[relative:]
    if protected_anchor_index is not None:
        anchor_body_index = max(0, int(protected_anchor_index) - prefix_size)
        if anchor_body_index >= len(conversation) - prefix_size:
            return BudgetResult(False, 0)
        anchor_message = conversation[prefix_size + anchor_body_index]
        if protected_from is not None and protected_anchor_index >= protected_from:
            return BudgetResult(False, 0)
        previous_relative = None
        if protected_previous_from is not None:
            previous_relative = max(0, int(protected_previous_from) - prefix_size)
            if previous_relative < anchor_body_index:
                previous_protected_tail = body[previous_relative:anchor_body_index]
        before_previous = previous_relative if previous_protected_tail else anchor_body_index
        body = body[:before_previous] + body[anchor_body_index + 1:relative]
    elif protected_from is not None:
        body = body[:relative]

    if protected_anchor_index is not None and anchor_message is not None:
        # 运行中滚动窗口保留摘要、当前用户锚点和最后一次工具往返。
        from .summary_format import SUMMARY_OPEN

        summaries = [
            message for message in body
            if message.get("role") == "summary"
            or SUMMARY_OPEN in str(message.get("content") or "")
        ]
        previous_protected_start_index = len(prefix) + len(summaries)
        anchor_result_index = previous_protected_start_index + len(previous_protected_tail)
        fixed = prefix + summaries + previous_protected_tail + [anchor_message]
        tail_units = _units(protected_tail)
        last_unit = next(
            (unit for unit in reversed(tail_units) if _has_tool_call(protected_tail[unit[0]])),
            tail_units[-1] if tail_units else [],
        )
        source_offset = last_unit[0] if last_unit else len(protected_tail)
        kept = protected_tail[source_offset:]
        result = fixed + kept
        if result == conversation and last_unit and _has_tool_call(protected_tail[last_unit[0]]):
            # 连同工具结果一起移除超限的往返，保留它后面的消息。
            source_offset = last_unit[-1] + 1
            result = fixed + protected_tail[source_offset:]
        if result == conversation:
            return BudgetResult(False, 0)
        messages.replace_request_baseline(result, expected_revision=messages.revision)
        return BudgetResult(
            True, len(conversation) - len(result),
            protected_start_index=len(fixed), anchor_index=anchor_result_index,
            protected_source_start_index=prefix_size + relative + source_offset,
            previous_protected_start_index=(
                previous_protected_start_index if previous_protected_tail else None
            ),
        )

    units = _units(body)
    unit_offset = protected_unit_offset(units)
    kept = [body[index] for unit in units[unit_offset:] for index in unit]
    result = prefix + kept + protected_tail
    if len(result) == len(conversation):
        return BudgetResult(False, 0)
    messages.replace_request_baseline(result, expected_revision=messages.revision)
    return BudgetResult(True, len(conversation) - len(result))


def is_context_overflow_error(error: BaseException) -> bool:
    """识别明确的输入上下文超限；输出上限错误不能靠压缩历史修复。"""
    pending = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        fields = {}
        fields["exception_message"] = str(current)
        for name in ("code", "type", "param", "message", "status_code"):
            value = getattr(current, name, None)
            if value is not None:
                fields[name] = value
        body = getattr(current, "body", None)
        if isinstance(body, dict):
            fields.update(body)
        response = getattr(current, "response", None)
        status = getattr(response, "status_code", None)
        if status is not None:
            fields["status_code"] = status
        pending.extend((getattr(current, "cause", None), current.__cause__, current.__context__))

        searchable = " ".join(str(value) for value in fields.values()).lower()
        explicit_codes = (
            "request_too_large", "context_length_exceeded", "context_window_exceeded",
            "input_too_long", "prompt_too_long",
        )
        if any(code in searchable for code in explicit_codes):
            return True
        # 常见 OpenAI-compatible 文案；不接受 max_tokens/output 限制作为上下文溢出。
        if any(marker in searchable for marker in ("max_tokens", "maximum output", "output token limit")):
            continue
        phrases = CONTEXT_OVERFLOW_PHRASES
        if any(phrase in searchable for phrase in phrases):
            return True
        status = fields.get("status_code") or fields.get("status")
        if str(status) == "413":
            return True
    return False
