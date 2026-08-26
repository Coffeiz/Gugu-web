"""上下文超量时的确定性截断测试。"""

from agent.context.budget import (
    ContextBudget,
    enforce_message_budget,
    estimate_tool_schema_tokens,
    truncate_messages,
)
from agent.context.assembly import PromptMessages
from agent.context.tokens import estimate_tokens, message_text


def test_context_budget_uses_one_total_and_history_capacity_semantics():
    budget = ContextBudget.for_history(
        128_000,
        fixed_prefix_text="系统提示" * 100,
        tool_schema_tokens=300,
        turn_batch_tokens=120,
        current_turn_tokens=80,
    )

    assert budget.total_tokens == budget.non_history_tokens
    assert budget.history_capacity_tokens == budget.soft_limit_tokens - budget.non_history_tokens
    assert budget.compression_cap_tokens == 64_000
    assert budget.diagnostics()["history_capacity_tokens"] == budget.history_capacity_tokens


def test_context_budget_from_messages_has_one_breakdown():
    messages = [
        {"role": "system", "content": "稳定快照" * 10},
        {"role": "user", "content": "历史" * 20},
        {"role": "user", "content": "当前问题"},
    ]
    budget = ContextBudget.from_messages(
        10_000,
        messages,
        system_text="系统" * 10,
        fixed_prefix_size=1,
        tool_schema_tokens=31,
        turn_batch_tokens=17,
    )

    assert budget.total_tokens == (
        budget.system_prompt_tokens
        + budget.snapshot_tokens
        + budget.history_tokens
        + budget.tool_schema_tokens
        + budget.turn_batch_tokens
    )
    assert budget.snapshot_tokens == estimate_tokens(messages[0]["content"])
    assert budget.history_tokens == sum(
        estimate_tokens(message_text(message)) for message in messages[1:]
    )


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
    assert stats.after_tokens <= ContextBudget(120).soft_limit_tokens + 10


def test_single_oversized_current_message_is_truncated_without_llm():
    messages = [{"role": "user", "content": "很长" * 10000}]

    result, stats = truncate_messages(messages, context_tokens=100)

    assert stats.changed
    assert stats.oversized_item
    assert "内容因上下文预算被截断" in result[-1]["content"]
    assert stats.after_tokens <= ContextBudget(100).soft_limit_tokens + 10


def test_valid_history_is_not_trimmed():
    messages = [{"role": "user", "content": "短消息"}]

    result, stats = truncate_messages(messages, context_tokens=1000)

    assert result == messages
    assert not stats.changed


def test_over_budget_first_keeps_recent_twenty_messages():
    messages = [{"role": "user", "content": f"消息 {index} " + "x" * 200} for index in range(22)]

    result, stats = truncate_messages(messages, context_tokens=1200)

    assert stats.changed
    assert [item["content"].split()[1] for item in result] == [str(index) for index in range(2, 22)]


def test_tool_schema_reservation_is_included_in_hard_budget():
    """工具 schema 很大时，历史不能占满模型的完整 context window。"""
    tools = [{
        "name": "large_tool",
        "description": "工具说明" * 300,
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}},
    }]
    overhead = estimate_tool_schema_tokens(tools)
    messages = [{"role": "user", "content": "历史消息 " * 300}]

    result, stats = truncate_messages(
        messages,
        context_tokens=2500,
        overhead_tokens=overhead,
    )

    assert overhead > 0
    assert stats.changed
    assert stats.after_tokens <= ContextBudget(2500, provider_overhead_tokens=overhead).soft_limit_tokens + 10


def test_turn_batch_is_counted_during_truncation():
    """本轮 batch 消息参与预算，不能绕过历史截断逻辑。"""
    messages = PromptMessages(
        conversation=[
            {"role": "user", "content": "旧历史 " * 200},
            {"role": "user", "content": "当前问题"},
        ],
    )
    messages.append({"role": "user", "content": "本轮 batch " * 100})

    result = enforce_message_budget(messages, "", 1200)

    assert result.changed
    assert result.after_tokens <= ContextBudget(1200).soft_limit_tokens + 10
    assert "旧历史" not in str(messages.conversation)
