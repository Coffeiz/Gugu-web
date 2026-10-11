from datetime import datetime, timezone
from types import SimpleNamespace

from agent.context.assembly import MessageArea
from agent.context.assembly.area import MessageSource, PersistencePolicy
from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.history import render_canonical_area_snapshot
from agent.providers.base import ProviderAdapter
from agent.providers.message_utils import _with_history_cache
from agent.context.provider_conversation import ProviderConversation


class _Adapter:
    name = "test-provider"

    def render_history(self, messages):
        return render_events_for_provider(messages)


class _OpenAIAdapter(ProviderAdapter):
    name = "test-openai"
    api_format = "openai"


def test_provider_conversation_is_immutable_and_bound_to_area_snapshot():
    messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": "旧问题"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "lookup", "arguments": {},
        }]},
    ])
    messages.configure_request(fixed_prefix=(), render_options={"api_format": "openai"})
    area = messages
    before = area.snapshot()

    projection = messages.provider_projection()
    assert isinstance(projection, ProviderConversation)
    assert projection.area_revision == before.revision
    assert projection.area_digest == before.digest
    assert projection.to_messages()[1]["tool_calls"][0]["function"]["name"] == "lookup"

    mutated = projection.to_messages()
    mutated[0]["content"] = "只改请求副本"
    assert projection.to_messages()[0]["content"] == "旧问题"
    assert area.snapshot() == before


def test_cache_state_reuses_append_only_area_prefix_but_resets_after_prefix_edit():
    messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": "首轮问题"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-1", "name": "lookup", "arguments": {},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-1", "content": "等待结果",
        }]},
    ])
    first, state = _with_history_cache(messages.provider_projection())
    baseline = state.baseline_digest
    entry_count = state.area_entry_count

    messages.append({"role": "user", "content": "下一轮问题"})
    second, next_state = _with_history_cache(messages.provider_projection(), state)
    assert next_state.revision == state.revision + 1
    assert next_state.baseline_digest == baseline
    assert next_state.area_entry_count > entry_count
    assert first.area_digest != ""
    assert second.area_digest == messages.digest()

    messages.resolve_tool_result(
        tool_call_id="call-1", result={"status": "success", "value": "已完成"},
    )
    _edited, edited_state = _with_history_cache(
        messages.provider_projection(), next_state,
    )
    assert edited_state.revision == 1
    assert edited_state.area_digest == messages.digest()
    assert edited_state.area_revision == messages.revision


def test_cache_state_restarts_after_area_baseline_compaction():
    messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": "旧历史"},
        {"role": "assistant", "content": "旧回复"},
        {"role": "user", "content": "当前问题"},
    ])
    _first, state = _with_history_cache(messages.provider_projection())
    area_digest = state.area_digest

    # 压缩通过 Area 的受控替换推进 revision，旧缓存状态不得跨越新 baseline。
    messages.replace_request_baseline([
        {"role": "user", "content": "压缩摘要"},
        {"role": "user", "content": "当前问题"},
    ], expected_revision=messages.revision)
    _compacted, compacted_state = _with_history_cache(
        messages.provider_projection(), state,
    )

    assert compacted_state.revision == 1
    assert compacted_state.area_digest != area_digest
    assert compacted_state.projection_prefix_digest != state.projection_prefix_digest


def test_adapter_projects_restored_canonical_area_without_mutating_it():
    sent_at = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
    area = MessageArea.from_restored([{
        "_history_id": 7,
        "role": "user",
        "content": "",
        "content_json": [{"type": "text", "text": "旧问题"}],
        "sent_at": sent_at.isoformat(),
    }])
    area.configure_request(
        fixed_prefix=[{"role": "system", "content": "固定前缀"}],
        render_options={
            "api_format": "openai",
            "request": SimpleNamespace(chat_id=None, source="web"),
            "user_tz": timezone.utc,
        },
    )
    before = area.snapshot()

    projection = _OpenAIAdapter().render_history(area)

    assert projection.area_digest == before.digest
    assert projection.area_revision == before.revision
    assert projection[0]["role"] == "system"
    assert projection[0]["content"] == "固定前缀"
    assert "消息时间：2026-09-30 12:00" in projection[1]["content"][0]["text"]
    assert projection[2] == {"role": "user", "content": "旧问题"}
    assert area.snapshot() == before


def test_projection_preserves_tool_and_multimodal_canonical_event_order():
    area = MessageArea()
    area.append({
        "role": "user",
        "content": [
            {"type": "knowledge-context", "text": "引用资料"},
            {"type": "text", "text": "看这张图"},
            {"type": "image_url", "image_url": {"url": "https://example.invalid/i.png"}},
        ],
    }, source=MessageSource.ATTACHMENT)
    area.append({
        "role": "assistant",
        "content": [{"type": "tool_call", "id": "call-a", "name": "lookup", "arguments": "{\"x\":1}"}],
    }, source=MessageSource.TOOL_ROUND, persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS)
    area.append({
        "role": "user",
        "content": [{"type": "tool_result", "tool_call_id": "call-a", "content": "ok"}],
    }, source=MessageSource.TOOL_ROUND, persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS)
    snapshot = area.snapshot()

    area.configure_request(
        fixed_prefix=(),
        render_options={"api_format": "openai", "request": SimpleNamespace(chat_id=None, source="web")},
    )
    projection = render_canonical_area_snapshot(
        snapshot, source=area,
        options=area.render_options,
    )

    assert projection[0]["content"][0]["text"] == "引用资料"
    assert projection[0]["content"][1]["text"] == "看这张图"
    assert projection[0]["content"][2]["type"] == "image_url"
    assert projection[1]["tool_calls"][0]["function"]["arguments"] == '{"x":1}'
    assert projection[2]["role"] == "tool"
    assert projection[2]["content"] == "ok"
    assert area.snapshot() == snapshot
