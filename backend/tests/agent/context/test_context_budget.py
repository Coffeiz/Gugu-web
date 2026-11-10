"""上下文超量时的确定性截断测试。"""

import pytest

from agent.context.assembly.area import MessageArea
from agent.context.budget import atomic_message_units, enforce_provider_overflow_fallback
from agent.context.dynamic_tail import unwrap_message_body_text


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


def test_provider_overflow_keeps_last_ten_complete_units_in_place():
    messages = MessageArea.from_canonical_messages(
        [{"role": "user", "content": f"消息{i}" + "x" * 100} for i in range(40)],
    )

    result = enforce_provider_overflow_fallback(messages)

    assert result.changed
    assert result.dropped_messages == 30
    projected = messages.provider_projection().to_messages()
    assert len(projected) == 10
    assert unwrap_message_body_text(projected[0]["content"]).startswith("消息30")
    assert unwrap_message_body_text(projected[-1]["content"]).startswith("消息39")


def test_provider_overflow_keeps_last_ten_complete_units():
    messages = MessageArea.from_canonical_messages(
        [{"role": "user", "content": f"m{index}" + "y" * 900} for index in range(30)],
    )

    result = enforce_provider_overflow_fallback(messages)

    assert result.changed
    projected = messages.provider_projection().to_messages()
    assert len(projected) == 10
    assert unwrap_message_body_text(projected[0]["content"]).startswith("m20")


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
    assert unwrap_message_body_text(projected[-1]["content"]) == "受保护的收尾"
    assert len(projected) < original_count


@pytest.mark.parametrize(("history_size", "retained", "revision_delta"), [(3, 3, 0), (40, 10, 1)])
def test_provider_overflow_updates_baseline_only_when_history_changes(
    history_size, retained, revision_delta,
):
    history = MessageArea.from_canonical_messages(
        [{"role": "user", "content": f"合成消息{i}"} for i in range(history_size)],
    )
    original_revision = history.revision

    result = enforce_provider_overflow_fallback(history)

    assert result.changed is (history_size != retained)
    assert len(history.provider_projection()) == retained
    assert history.revision == original_revision + revision_delta


def test_overflow_shortens_large_tool_result_without_discarding_tool_exchange():
    original_result = "合成工具结果" * 2000
    area = MessageArea.from_canonical_messages([
        {"role": "user", "content": "保留原样的用户请求"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "search", "arguments": {},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-1", "content": original_result,
        }]},
    ])
    before = area.provider_projection().to_messages()

    result = enforce_provider_overflow_fallback(area, protected_from=1, protected_anchor_index=0)

    assert result.changed and result.dropped_messages == 0
    user, call, tool = area.provider_projection().to_messages()
    assert [user, call] == before[:2]
    assert tool["tool_call_id"] == before[-1]["tool_call_id"]
    assert "已截短" in str(tool["content"])
    assert len(str(tool["content"])) < len(original_result)
