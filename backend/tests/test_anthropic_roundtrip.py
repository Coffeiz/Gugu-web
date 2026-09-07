from agent.loop_drivers import AnthropicDriver, NormalizedToolCall, RoundResult
from agent.context.canonical_tool_history import canonical_tool_round
from agent.runtime.loopscope_trace.state import _anthropic_structure


def test_anthropic_tool_round_preserves_all_response_blocks_and_signature():
    call = NormalizedToolCall("call-1", "calendar_list", {"date": "2026-09-01"})
    result = RoundResult(
        text="查一下",
        tool_calls=[call],
        requires_tools=True,
        raw=[
            {"type": "thinking", "thinking": "内部思考", "signature": "sig-1"},
            {"type": "text", "text": "查一下"},
            {"type": "tool_use", "id": "call-1", "name": "calendar_list", "input": {"date": "2026-09-01"}},
        ],
    )
    driver = AnthropicDriver()
    messages = driver.build_tool_round(result, [(call, "ok")])

    assert messages[0]["content"] == result.raw
    assert messages[0]["content"][0]["type"] == "thinking"
    assert messages[0]["content"][0]["signature"] == "sig-1"
    assert messages[0]["content"][2]["type"] == "tool_use"


def test_anthropic_tool_round_drops_unprocessed_parallel_tool_uses():
    """确认门中断并行批次时，assistant/tool_result 必须保持严格配对。"""
    first = NormalizedToolCall("call-1", "delete_one", {})
    second = NormalizedToolCall("call-2", "delete_two", {})
    result = RoundResult(
        text="删除两个任务",
        tool_calls=[first, second],
        requires_tools=True,
        raw=[
            {"type": "text", "text": "删除两个任务"},
            {"type": "tool_use", "id": first.id, "name": first.name, "input": first.input},
            {"type": "tool_use", "id": second.id, "name": second.name, "input": second.input},
        ],
    )
    dispatched = [(first, '{"status":"waiting_input"}')]

    messages = AnthropicDriver().build_tool_round(result, dispatched)

    assert [block["id"] for block in messages[0]["content"] if block["type"] == "tool_use"] == ["call-1"]
    assert [block["tool_use_id"] for block in messages[1]["content"]] == ["call-1"]

    canonical = canonical_tool_round(result, dispatched)
    assert [block["id"] for block in canonical[0]["content"] if block["type"] == "tool_call"] == ["call-1"]
    assert [block["tool_call_id"] for block in canonical[1]["content"]] == ["call-1"]


def test_anthropic_structure_probe_contains_only_safe_structure_and_digest():
    blocks = [
        {"type": "thinking", "thinking": "不要出现在探针", "signature": "sig-1"},
        {"type": "text", "text": "不要出现在探针"},
        {"type": "tool_use", "id": "call-1", "name": "calendar_list", "input": {"date": "2026-09-01"}},
    ]
    summary, digest = _anthropic_structure(blocks)

    assert summary == {
        "blocks": ["thinking", "text", "tool_use"],
        "has_signature": True,
        "tool_names": ["calendar_list"],
        "response_digest": digest,
    }
    assert "thinking" not in summary
    assert "不要出现在探针" not in summary


def test_anthropic_structure_digest_detects_non_identical_roundtrip():
    original = [{"type": "thinking", "thinking": "a", "signature": "sig"}]
    changed = [{"type": "thinking", "thinking": "b", "signature": "sig"}]
    assert _anthropic_structure(original)[1] != _anthropic_structure(changed)[1]
