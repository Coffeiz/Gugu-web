from agent.loop_drivers import AnthropicDriver, RoundResult
from agent.runtime.loopscope_trace.state import _anthropic_structure


def test_anthropic_tool_round_preserves_all_response_blocks_and_signature():
    result = RoundResult(
        text="查一下",
        tool_calls=[],
        requires_tools=True,
        raw=[
            {"type": "thinking", "thinking": "内部思考", "signature": "sig-1"},
            {"type": "text", "text": "查一下"},
            {"type": "tool_use", "id": "call-1", "name": "calendar_list", "input": {"date": "2026-09-01"}},
        ],
    )
    driver = AnthropicDriver()
    messages = driver.build_tool_round(result, [])

    assert messages[0]["content"] == result.raw
    assert messages[0]["content"][0]["type"] == "thinking"
    assert messages[0]["content"][0]["signature"] == "sig-1"
    assert messages[0]["content"][2]["type"] == "tool_use"


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
