from types import SimpleNamespace

from agent.context.canonical_tool_history import (
    SkillSchemaEvent,
    ToolCall,
    ToolResult,
    ToolSchemaEvent,
    append_event,
    canonical_event_stats,
    render_events_for_provider,
    schema_digest,
)
from agent.loop_drivers import NormalizedToolCall
from agent.context.history import build_history_parts, canonicalize_tool_messages


def test_schema_event_has_stable_digest_and_is_deduplicated():
    schema = {"name": "weather", "input_schema": {"type": "object"}}
    event = ToolSchemaEvent("weather", 1, schema_digest(schema), schema)
    messages = []
    append_event(messages, event)
    append_event(messages, event)
    assert len(messages) == 1
    assert messages[0]["content"][0]["type"] == "tool-schema"
    assert messages[0]["content"][0]["schema_digest"] == schema_digest(schema)


def test_canonical_events_render_as_text_without_provider_wire_blocks():
    messages = []
    append_event(messages, SkillSchemaEvent("image-analysis", ("image_search", "inspect_images")))
    rendered = render_events_for_provider(messages)
    assert rendered[0]["role"] == "user"
    assert isinstance(rendered[0]["content"], str)
    assert "canonical skill-schema" in rendered[0]["content"]
    assert "tool_result" not in rendered[0]["content"]


def test_canonical_event_round_trips_through_persisted_history():
    original = [{
        "role": "user",
        "content": [{
            "type": "tool-schema", "tool_name": "weather", "schema_version": 1,
            "schema_digest": "digest", "schema": {"type": "object"},
        }],
    }]
    persisted = canonicalize_tool_messages(original)
    assert persisted[0]["content"][0]["type"] == "tool-schema"
    message = SimpleNamespace(
        role="user", content="", content_json=persisted[0]["content"],
        sent_at=None, chat_type=None, platform_user_id=None, platform_user_name=None,
    )
    openai = build_history_parts([message], None, use_anthropic=False)
    anthropic = build_history_parts([message], None, use_anthropic=True)
    assert "weather" in openai[0]["content"]
    assert anthropic[0]["content"][0]["type"] == "text"


def test_canonical_event_stats_are_aggregated_without_exposing_payloads():
    messages = [{
        "role": "user",
        "content": [
            {"type": "tool-schema", "tool_name": "weather", "schema_digest": "abc123"},
            {"type": "skill-schema", "skill_name": "weather", "tool_names": ["weather"]},
            {"type": "tool_result", "content": "private result"},
        ],
    }]
    stats = canonical_event_stats(messages)
    assert stats == {
        "count": 3,
        "by_type": {"skill-schema": 1, "tool-schema": 1, "tool_result": 1},
        "schema_digests": ["abc123"],
    }


def test_tool_dataclasses_round_trip_provider_neutral_blocks():
    call = ToolCall("call-1", "weather", {"city": "南京"})
    result = ToolResult("call-1", {"temperature": 26}, tool_name="weather")

    assert call.arguments == call.input
    assert call.to_block() == {
        "type": "tool_call",
        "id": "call-1",
        "name": "weather",
        "arguments": {"city": "南京"},
    }
    assert result.to_block() == {
        "type": "tool_result",
        "tool_call_id": "call-1",
        "content": {"temperature": 26},
        "tool_name": "weather",
    }

    assert ToolCall.from_block({
        "type": "tool_use", "id": "call-1", "name": "weather",
        "input": {"city": "南京"},
    }) == call
    assert ToolResult.from_block({
        "type": "tool_result", "tool_use_id": "call-1",
        "content": {"temperature": 26}, "tool_name": "weather",
    }) == result


def test_normalized_tool_call_reuses_canonical_tool_call_fields():
    call = NormalizedToolCall("call-1", "weather", {"city": "南京"}, parse_error=True)
    assert isinstance(call, ToolCall)
    assert call.arguments == {"city": "南京"}
    assert call.parse_error is True
