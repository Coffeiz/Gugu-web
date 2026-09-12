from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.canonical_context import CanonicalContext, normalize_history_message
from agent.context.context_assembly import build_messages
from agent.context.canonical_request import CanonicalRequest
from agent.providers.anthropic_history_adapter import AnthropicHistoryAdapter
from agent.providers.openai_history_adapter import OpenAIHistoryAdapter


def test_rendering_does_not_mutate_canonical_messages_or_lose_context_metadata():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "固定"}],
        history=[],
        current_batch=[{"role": "user", "content": [{
                "type": "tool-schema",
                "tool_name": "search",
                "schema_version": 1,
                "schema_digest": "abc",
                "schema": {"name": "search"},
            }]}],
    )
    original = list(messages)
    rendered = render_events_for_provider(messages)
    assert list(messages) == original
    assert rendered.canonical_context is messages.canonical_context
    assert "canonical tool-schema" in str(rendered[1]["content"])


def test_openai_and_anthropic_render_same_canonical_history_without_changing_digest():
    envelopes = (
        normalize_history_message({
            "role": "assistant",
            "content_json": [{"type": "tool_call", "id": "t1", "name": "search", "input": {"q": "x"}}],
        }),
        normalize_history_message({
            "role": "tool", "tool_call_id": "t1", "content": "ok",
        }),
    )
    context = CanonicalContext(canonical_history=tuple(item.to_dict() for item in envelopes))
    request = CanonicalRequest(context=context, provider="test", api_format="openai", model="m")
    openai = OpenAIHistoryAdapter(None).render_envelopes(request, envelopes)
    anthropic = AnthropicHistoryAdapter(None).render_envelopes(request, envelopes)
    assert openai.canonical_digest == anthropic.canonical_digest == request.canonical_digest
    assert openai.messages[0]["tool_calls"][0]["function"]["name"] == "search"
    assert openai.messages[1]["role"] == "tool"
    assert anthropic.messages[0]["content"][0]["type"] == "tool_use"
    assert anthropic.messages[1]["content"][0]["type"] == "tool_result"


def test_openai_adapter_passes_raw_string_arguments_verbatim():
    """OpenAI 回放对字符串 arguments 原样透传：跨 run 缓存要求与 live wire 逐字节一致。"""
    raw_args = '{"name": "read_file", "arguments": {"file_id": 5559}}'
    envelopes = (
        normalize_history_message({
            "role": "assistant",
            "content_json": [{"type": "tool_call", "id": "t1", "name": "call_tool", "arguments": raw_args}],
        }),
        normalize_history_message({"role": "tool", "tool_call_id": "t1", "content": "ok"}),
    )
    request = CanonicalRequest(context=CanonicalContext(canonical_history=tuple(
        item.to_dict() for item in envelopes)), provider="test", api_format="openai", model="m")
    rendered = OpenAIHistoryAdapter(None).render_envelopes(request, envelopes)
    wire_args = rendered.messages[0]["tool_calls"][0]["function"]["arguments"]
    assert wire_args == raw_args
    assert isinstance(wire_args, str)


def test_anthropic_adapter_parses_raw_string_arguments_into_object():
    """Anthropic 的 tool_use.input 必须是对象：字符串 arguments 解回 dict，不能丢成空对象。"""
    raw_args = '{"name": "read_file", "arguments": {"file_id": 5559}}'
    envelopes = (
        normalize_history_message({
            "role": "assistant",
            "content_json": [{"type": "tool_call", "id": "t1", "name": "call_tool", "arguments": raw_args}],
        }),
        normalize_history_message({"role": "tool", "tool_call_id": "t1", "content": "ok"}),
    )
    request = CanonicalRequest(context=CanonicalContext(canonical_history=tuple(
        item.to_dict() for item in envelopes)), provider="test", api_format="anthropic", model="m")
    rendered = AnthropicHistoryAdapter(None).render_envelopes(request, envelopes)
    tool_use = rendered.messages[0]["content"][0]
    assert tool_use["type"] == "tool_use"
    assert tool_use["input"] == {"name": "read_file", "arguments": {"file_id": 5559}}


def test_anthropic_adapter_coerces_malformed_string_arguments_to_empty_object():
    envelopes = (
        normalize_history_message({
            "role": "assistant",
            "content_json": [{"type": "tool_call", "id": "t1", "name": "call_tool", "arguments": "不是JSON"}],
        }),
    )
    request = CanonicalRequest(context=CanonicalContext(canonical_history=tuple(
        item.to_dict() for item in envelopes)), provider="test", api_format="anthropic", model="m")
    rendered = AnthropicHistoryAdapter(None).render_envelopes(request, envelopes)
    assert rendered.messages[0]["content"][0]["input"] == {}
