"""上下文超量时的确定性截断测试。"""

from agent.context.budget import (
    ContextBudget,
    _fit_oversized_message,
    _truncate_value,
    atomic_message_units,
    enforce_message_budget,
    enforce_provider_overflow_fallback,
    estimate_tool_schema_tokens,
    truncate_messages,
)
from agent.context.assembly import MessageArea
from agent.context.tokens import estimate_tokens, message_text


def test_context_budget_uses_one_total_and_history_capacity_semantics():
    budget = ContextBudget.from_parts(
        128_000,
        system_prompt_tokens=estimate_tokens("系统提示" * 100),
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


def test_atomic_message_units_keep_tool_call_and_consecutive_results_together():
    messages = [
        {"role": "user", "content": "之前的问题"},
        {
            "role": "assistant",
            "tool_calls": [{"id": "call-1"}, {"id": "call-2"}],
            "content": None,
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "结果一"},
        {"role": "tool", "tool_call_id": "call-2", "content": "结果二"},
        {"role": "user", "content": "当前问题"},
    ]

    assert atomic_message_units(messages) == [[0], [1, 2, 3], [4]]


def test_atomic_message_units_keep_trailing_tool_call_without_orphan_result():
    messages = [{"role": "assistant", "tool_calls": [{"id": "call-last"}], "content": None}]

    assert atomic_message_units(messages) == [[0]]


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


def test_over_budget_first_keeps_recent_ten_complete_units():
    messages = [{"role": "user", "content": f"消息 {index} " + "x" * 200} for index in range(22)]

    result, stats = truncate_messages(messages, context_tokens=1200)

    assert stats.changed
    assert [item["content"].split()[1] for item in result] == [str(index) for index in range(12, 22)]


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
    messages = MessageArea.from_canonical_messages(
        [
            {"role": "user", "content": "旧历史 " * 200},
            {"role": "user", "content": "当前问题"},
        ],
    )
    messages.append({"role": "user", "content": "本轮 batch " * 100})

    result = enforce_message_budget(messages, "", 1200)

    assert result.changed
    assert result.after_tokens <= ContextBudget(1200).soft_limit_tokens + 10
    assert "旧历史" not in str(messages.provider_projection().to_messages())


def test_truncate_messages_protects_tail_from_index():
    messages = [{"role": "user", "content": f"m{i}" + "a" * 120} for i in range(30)]
    messages[-1]["content"] = "必须保留的收尾"

    result, stats = truncate_messages(messages, context_tokens=300, protected_from=28)

    assert stats.changed
    assert result[-2:] == messages[28:]
    assert all(item["content"] != "必须保留的收尾" for item in result[:-2])


def test_truncate_messages_target_ratio_tightens_cap():
    messages = [{"role": "user", "content": "b" * 120} for _ in range(30)]

    plain, plain_stats = truncate_messages(messages, context_tokens=400)
    tight, tight_stats = truncate_messages(messages, context_tokens=400, target_ratio=0.05)

    assert plain_stats.changed and tight_stats.changed
    assert tight_stats.after_tokens <= plain_stats.after_tokens
    assert len(tight) < len(plain)


def test_provider_overflow_noop_when_within_limits():
    messages = MessageArea.from_canonical_messages(
        [{"role": "user", "content": "短消息"} for _ in range(3)],
    )

    result = enforce_provider_overflow_fallback(messages, context_tokens=100)

    assert not result.changed
    assert result.oversized_item is False
    assert len(messages.provider_projection()) == 3


def test_provider_overflow_keeps_last_ten_complete_units_in_place():
    messages = MessageArea.from_canonical_messages(
        [{"role": "user", "content": f"消息{i}" + "x" * 100} for i in range(40)],
    )

    result = enforce_provider_overflow_fallback(messages)

    assert result.changed
    assert result.dropped_messages == 30
    projected = messages.provider_projection().to_messages()
    assert len(projected) == 10
    assert projected[0]["content"].startswith("消息30")
    assert projected[-1]["content"].startswith("消息39")


def test_provider_overflow_keeps_last_ten_complete_units():
    messages = MessageArea.from_canonical_messages(
        [{"role": "user", "content": f"m{index}" + "y" * 900} for index in range(30)],
    )

    result = enforce_provider_overflow_fallback(messages)

    assert result.changed
    projected = messages.provider_projection().to_messages()
    assert len(projected) == 10
    assert projected[0]["content"].startswith("m20")


def test_provider_overflow_keeps_tool_round_atomic():
    messages = MessageArea.from_canonical_messages([
        *[{"role": "user", "content": "旧消息" + "a" * 80} for _ in range(30)],
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "search", "arguments": {},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-1", "content": "工具结果",
        }]},
    ])

    result = enforce_provider_overflow_fallback(messages)

    assert result.changed
    projected = messages.provider_projection().to_messages()
    tool_index = next(index for index, item in enumerate(projected) if item.get("role") == "tool")
    assert projected[tool_index - 1].get("tool_calls")
    assert all(item.get("role") != "tool" for item in projected[:tool_index - 1])


def test_provider_overflow_preserves_fixed_prefix_and_protected_tail():
    from agent.context.assembly import MessageArea

    conversation = [{"role": "user", "content": f"m{i}" + "b" * 120} for i in range(30)]
    conversation[-1]["content"] = "受保护的收尾"
    original_count = len(conversation)
    history = MessageArea.from_canonical_messages(list(conversation), fixed_prefix_size=1)

    result = enforce_provider_overflow_fallback(history, protected_from=28)

    assert result.changed
    projected = history.provider_projection().to_messages()
    assert projected[0]["content"] == conversation[0]["content"]
    assert projected[-1]["content"] == "受保护的收尾"
    assert len(projected) < original_count


def test_provider_overflow_updates_area_baseline_as_one_revision():
    history = MessageArea.from_canonical_messages(
        [{"role": "user", "content": f"m{i}" + "c" * 100} for i in range(40)],
    )
    original_revision = history.revision

    result = enforce_provider_overflow_fallback(history)

    assert result.changed
    assert len(history.provider_projection()) == 10
    assert history.revision == original_revision + 1


def test_provider_overflow_truncates_single_giant_message():
    messages = MessageArea.from_canonical_messages(
        [{"role": "user", "content": "z" * 30_000}],
    )

    result = enforce_provider_overflow_fallback(messages, context_tokens=100)

    assert result.changed
    assert result.oversized_item is True
    assert len(messages.provider_projection()[0]["content"]) < 30_000


def test_truncate_value_traverses_nested_structures():
    value = {
        "text": "长" * 2_000,
        "list": ["短", "长" * 2_000],
        "nested": {"deep": "深" * 2_000},
        "number": 42,
        "none": None,
    }

    result = _truncate_value(value, 60)

    assert result["number"] == 42
    assert result["none"] is None
    assert len(result["text"]) < 2_000
    assert result["list"][0] == "短"
    assert len(result["list"][1]) < 2_000
    assert len(result["nested"]["deep"]) < 2_000


def test_fit_oversized_message_truncates_each_field():
    message = {
        "role": "assistant",
        "content": [{"type": "text", "text": "块" * 2_000}],
        "reasoning_content": "思" * 2_000,
        "tool_calls": [{"id": "call-1", "function": {"name": "shell", "arguments": "{\"c\": \"" + "参" * 2_000 + "\"}"}}],
    }

    result = _fit_oversized_message(message, 80)

    assert len(str(result["reasoning_content"])) < 2_000
    assert len(result["tool_calls"][0]["function"]["arguments"]) < 4_000
    assert len(result["content"][0]["text"]) < 2_000
