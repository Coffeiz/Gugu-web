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
        current_user={
            "role": "user",
            "content": [{
                "type": "tool-schema",
                "tool_name": "search",
                "schema_version": 1,
                "schema_digest": "abc",
                "schema": {"name": "search"},
            }],
        },
        dynamic_tail=[],
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
