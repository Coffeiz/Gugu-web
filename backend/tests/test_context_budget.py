"""上下文超量时的确定性截断测试。"""

from agent.context.budget import effective_budget, truncate_messages
from agent.context.tokens import estimate_tokens, message_text


def test_over_budget_keeps_latest_tool_round_atomic():
    messages = [
        {"role": "user", "content": "旧消息" * 80},
        {"role": "assistant", "tool_calls": [{"id": "call-1", "function": {"name": "search", "arguments": "{}"}}], "content": None},
        {"role": "tool", "tool_call_id": "call-1", "content": "结果" * 8},
        {"role": "user", "content": "当前问题"},
    ]

    result, stats = truncate_messages(messages, context_tokens=120)

    assert stats.changed
    assert result[-1]["content"] == "当前问题"
    tool_indices = [index for index, item in enumerate(result) if item.get("role") == "tool"]
    assert not tool_indices or any(item.get("tool_calls") for item in result[:tool_indices[0]])
    assert stats.after_tokens <= effective_budget(120) + 10


def test_single_oversized_current_message_is_truncated_without_llm():
    messages = [{"role": "user", "content": "很长" * 10000}]

    result, stats = truncate_messages(messages, context_tokens=100)

    assert stats.changed
    assert stats.oversized_item
    assert "内容因上下文预算被截断" in result[-1]["content"]
    assert stats.after_tokens <= effective_budget(100) + 10


def test_valid_history_is_not_trimmed():
    messages = [{"role": "user", "content": "短消息"}]

    result, stats = truncate_messages(messages, context_tokens=1000)

    assert result == messages
    assert not stats.changed

