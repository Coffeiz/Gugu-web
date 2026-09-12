import json
from types import SimpleNamespace

from agent.context.canonical_tool_history import (
    SkillSchemaEvent,
    ToolCall,
    ToolResult,
    ToolSchemaEvent,
    append_event,
    canonical_event_stats,
    canonical_tool_round,
    tool_schema_event,
    render_events_for_provider,
    schema_digest,
)
from agent.context.canonical_context import normalize_history_message
from agent.loop_drivers import NormalizedToolCall
from agent.context.history import build_history_parts, canonicalize_tool_messages
from agent.security.sanitize import sanitize_messages
from agent.context.assembly.batch import NewMessageBatch


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
    assert isinstance(rendered[0]["content"], list)
    assert rendered[0]["content"][0]["type"] == "text"
    rendered_text = rendered[0]["content"][0]["text"]
    assert "canonical skill-schema" in rendered_text
    assert "tool_result" not in rendered_text


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
    assert openai[0]["content"][0]["type"] == "tool-schema"
    assert "weather" in render_events_for_provider(openai)[0]["content"][0]["text"]
    assert anthropic[0]["content"][0]["type"] == "tool-schema"
    assert "weather" in render_events_for_provider(anthropic)[0]["content"][0]["text"]


def test_time_reminders_round_trip_without_changing_provider_text():
    original = [{
        "role": "user",
        "content": "[system-reminder]\n当前时间：2026-08-26（星期三）14:24\n[/system-reminder]",
    }]

    persisted = canonicalize_tool_messages(original)

    assert persisted == [{
        "role": "user",
        "content": [{
            "type": "time-context",
            "text": original[0]["content"],
        }],
    }]
    message = SimpleNamespace(
        role="user", content="", content_json=persisted[0]["content"],
        sent_at=None, chat_type=None, platform_user_id=None, platform_user_name=None,
    )
    restored = build_history_parts([message], None, use_anthropic=False)
    assert render_events_for_provider(restored)[0]["content"] == [{
        "type": "text",
        "text": original[0]["content"],
    }]


def test_legacy_time_text_is_normalized_before_provider_boundary():
    message = {"role": "user", "content_json": [{
        "type": "text",
        "text": "[system-reminder]\n08-27 18:27\n[/system-reminder]",
    }]}
    envelope = normalize_history_message(message)
    assert envelope.content_blocks == ({
        "type": "time-context",
        "text": message["content_json"][0]["text"],
    },)


def test_time_context_wrapper_regression_guard_keeps_legacy_and_canonical_wire_equal():
    text = "[system-reminder]\n08-27 18:27\n[/system-reminder]"
    legacy = SimpleNamespace(
        role="user", content="", content_json=[{"type": "text", "text": text}],
        sent_at=None, chat_type=None, platform_user_id=None, platform_user_name=None,
        files=None, quoted_text=None,
    )
    canonical = SimpleNamespace(
        role="user", content="", content_json=[{"type": "time-context", "text": text}],
        sent_at=None, chat_type=None, platform_user_id=None, platform_user_name=None,
        files=None, quoted_text=None,
    )
    legacy_wire = render_events_for_provider(build_history_parts([legacy], None, use_anthropic=True))
    canonical_wire = render_events_for_provider(build_history_parts([canonical], None, use_anthropic=True))
    assert legacy_wire == canonical_wire


def test_provider_projection_drops_null_metadata_and_normalizes_stance_wrapper():
    """跨 run 的同一语义不能因响应元数据或 stance block 类型变化而断缓存。"""
    stance_text = "[system-reminder]\n## 本轮相处方式：查询\n[/system-reminder]"
    legacy = [{
        "role": "user",
        "content": [{
            "type": "text",
            "text": stance_text,
            "citations": None,
            "parsed_output": None,
            "caller": None,
            "toolset_name": None,
        }],
    }]
    canonical = [{
        "role": "user",
        "content": [{"type": "stance-context", "digest": "old", "text": stance_text}],
    }]

    assert render_events_for_provider(legacy) == render_events_for_provider(canonical)


def test_schema_event_never_shares_tool_result_message_boundary():
    messages = [{
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "ok"}],
    }]
    append_event(messages, ToolSchemaEvent("weather", 1, "digest", {"name": "weather"}))
    assert len(messages) == 2
    assert messages[0]["content"][0]["type"] == "tool_result"
    assert messages[1]["content"][0]["type"] == "tool-schema"


def test_sanitize_preserves_tool_result_and_schema_message_boundaries():
    """防止 Anthropic/MiniMax 发送前清洗时拼接 canonical user 消息。"""
    messages = [
        {"role": "system", "content": [{"type": "text", "text": "snapshot"}]},
        {"role": "user", "content": [{"type": "text", "text": "查询天气"}]},
        {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "call-1", "name": "weather", "input": {}}],
        },
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "ok"}],
        },
        {
            "role": "user",
            "content": [{"type": "tool-schema", "tool_name": "weather", "schema": {}}],
        },
    ]

    cleaned = sanitize_messages(messages)

    assert len(cleaned) == 5
    assert cleaned[3]["content"][0]["type"] == "tool_result"
    assert cleaned[4]["content"][0]["type"] == "tool-schema"


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


def test_canonical_tool_round_does_not_depend_on_provider_wire_shape():
    result = SimpleNamespace(
        text="准备查询",
        tool_calls=[ToolCall("call-1", "weather", {"city": "南京"})],
    )
    canonical = canonical_tool_round(result, [(result.tool_calls[0], {"ok": True})])

    assert canonical == [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "准备查询"},
                {"type": "tool_call", "id": "call-1", "name": "weather", "arguments": {"city": "南京"}},
            ],
        },
        {
            "role": "user",
            "content": [{
                "type": "tool_result", "tool_call_id": "call-1",
                "content": {"ok": True}, "tool_name": "weather",
            }],
        },
    ]


def test_canonical_tool_round_persists_openai_reasoning_content():
    result = SimpleNamespace(
        text="继续处理",
        raw=SimpleNamespace(reasoning="先确认工具结果，再继续。"),
        tool_calls=[],
    )

    canonical = canonical_tool_round(result, [])

    assert canonical == [{
        "role": "assistant",
        "content": [
            {"type": "text", "text": "继续处理"},
            {"type": "reasoning_content", "text": "先确认工具结果，再继续。"},
        ],
    }]
    message = SimpleNamespace(
        role="assistant", content="", content_json=canonical[0]["content"],
        sent_at=None, chat_type=None, platform_user_id=None, platform_user_name=None,
        files=None, quoted_text=None,
    )
    assert build_history_parts([message], None, use_anthropic=False) == [{
        "role": "assistant", "content": "继续处理",
        "reasoning_content": "先确认工具结果，再继续。",
    }]


def test_new_message_batch_accepts_persisted_reasoning_content():
    batch = NewMessageBatch.from_canonical_messages([{
        "role": "assistant",
        "content": [{"type": "reasoning_content", "text": "继续处理"}],
    }])

    assert batch.canonical_messages[0]["content"][0]["type"] == "reasoning_content"


def test_canonical_tool_round_keeps_provider_raw_arguments_bytes():
    """跨 run 缓存字节保真：canonical 必须存 provider 原始 arguments 字符串。

    live wire 发的就是这段原样字节（raw.tool_calls_payload 的 args）；parse→dict→
    dumps 会改变序列化风格（空格/键序），下一个 run 从 DB 回放时与 live 不一致，
    provider 前缀缓存在第一个工具轮就断开（2026-09-12 devserver run  事故）。
    """
    raw_args = '{"name": "read_file", "arguments": {"file_id": 5559}}'   # 带空格的 provider 原文
    result = SimpleNamespace(
        text="看一下",
        tool_calls=[NormalizedToolCall(
            id="call-1", name="call_tool",
            input={"name": "read_file", "arguments": {"file_id": 5559}},
            raw_arguments=raw_args,
        )],
    )
    canonical = canonical_tool_round(result, [(result.tool_calls[0], {"ok": True})])
    block = canonical[0]["content"][1]
    assert block["type"] == "tool_call"
    assert block["arguments"] == raw_args            # 原样字节，不是重新 dumps
    assert isinstance(block["arguments"], str)

    # 无 raw_arguments 时（旧路径/Anthropic dict）保持 dict，行为不变。
    result_dict_only = SimpleNamespace(
        text="查天气",
        tool_calls=[ToolCall("call-2", "weather", {"city": "南京"})],
    )
    canonical_dict = canonical_tool_round(
        result_dict_only, [(result_dict_only.tool_calls[0], {"ok": True})])
    assert canonical_dict[0]["content"][1]["arguments"] == {"city": "南京"}


def test_openai_replay_passes_raw_arguments_string_through_verbatim():
    """回放渲染对字符串 arguments 必须原样透传，与 live wire 逐字节一致。"""
    from agent.context.history import _openai_tool_call

    raw_args = '{"name": "read_file", "arguments": {"file_id": 5559}}'
    block = {"type": "tool_call", "id": "call-1", "name": "call_tool", "arguments": raw_args}
    wire = _openai_tool_call(block)
    assert wire["function"]["arguments"] == raw_args

    # 完整 round-trip：canonical_tool_round → DB json 往返 → 回放，字节不变。
    result = SimpleNamespace(
        text="",
        tool_calls=[NormalizedToolCall(
            id="call-1", name="call_tool",
            input={"name": "read_file", "arguments": {"file_id": 5559}},
            raw_arguments=raw_args,
        )],
    )
    canonical = canonical_tool_round(result, [(result.tool_calls[0], {"ok": True})])
    persisted = json.loads(json.dumps(canonical, ensure_ascii=False))
    replayed_block = next(b for b in persisted[0]["content"] if b.get("type") == "tool_call")
    assert _openai_tool_call(replayed_block)["function"]["arguments"] == raw_args
