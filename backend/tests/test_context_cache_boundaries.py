from agent.context.context_diagnostics import first_diff_index, request_diagnostics
from agent.context.context_assembly import build_messages
from agent.loop_drivers import (
    _history_cache_state,
    _with_history_cache,
    _with_single_history_cache,
)
from agent.providers.message_utils import (
    _with_system_cache_control,
    merge_openai_system_messages,
)
from agent.context.assembly import MessageArea, reminder
from agent.context.cache_state import CacheState
from agent.context.provider_conversation import ProviderConversation


class FakeAdapter:
    name = "deepseek"

    def supports_active_cache(self, model):
        return True

    def supports_explicit_cache(self, model):
        return False

    def uses_single_history_cache_anchor(self, model):
        return False

    def render_history(self, messages):
        if isinstance(messages, MessageArea):
            return messages.provider_projection()
        return messages


def test_first_diff_is_structural_and_diagnostics_are_digest_only():
    before = [{"role": "user", "content": "old"}, {"role": "system", "content": "time"}]
    after = [{"role": "user", "content": "old"}, {"role": "system", "content": "new"}]
    assert first_diff_index(before, after) == 1


def test_provider_projection_keeps_cache_state_outside_message_area():
    source = MessageArea.from_canonical_messages([
        {"role": "user", "content": [{"type": "text", "text": "历史"}]},
        {"role": "user", "content": [{"type": "text", "text": "本轮请求"}]},
    ])

    first_projection = source.provider_projection()
    first_cached, state = _with_history_cache(first_projection)
    assert not hasattr(source, "cache_anchor_indices")

    source.append({"role": "assistant", "content": [{"type": "tool_use", "name": "weather"}]})
    source.append({"role": "user", "content": [{"type": "tool_result", "content": "ok"}]})
    second_projection = source.provider_projection()
    second_cached, next_state = _with_history_cache(second_projection, state)

    assert state.baseline_digest
    assert next_state.baseline_digest == state.baseline_digest
    assert next_state.latest_digest
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[],
        current_batch=[
            {"role": "user", "content": "hello"},
            {"role": "system", "content": "time"},
        ],
    )
    result = request_diagnostics(
        messages, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
        api_format="openai",
    )
    assert result["first_diff_index"] is None
    assert result["wire_message_count"] == 2
    assert len(result["wire_message_diagnostics"]) == 2
    assert result["wire_role_sequence_digest"]
    assert result["wire_conversation_message_count"] == 2
    assert result["wire_turn_batch_count"] == 0
    assert result["wire_total_token_estimate"] >= 3
    assert result["wire_message_diagnostics"][-1]["cumulative_token_estimate"] == result[
        "wire_total_token_estimate"
    ]
    assert result["first_diff"] is None
    assert "hello" not in str(result)
    assert "time" not in str(result)


def test_anthropic_cache_baseline_survives_a_new_run_without_persisting_message_text():
    provider = "minimax"
    api_format = "anthropic"
    model = "MiniMax-M3.1-Flash-Preview"
    previous = MessageArea.from_canonical_messages([
        {"role": "system", "content": "固定系统前缀"},
        {"role": "user", "content": "上一轮用户输入"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-prev", "name": "lookup", "arguments": {},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-prev", "content": "已完成",
        }]},
        {"role": "assistant", "content": "上一轮回答"},
    ])
    _, previous_state = _with_history_cache(
        previous.provider_projection(),
        provider=provider,
        api_format=api_format,
        model=model,
    )
    stored_anchor = previous_state.to_session_anchor()

    next_run = MessageArea.from_canonical_messages([
        {"role": "system", "content": "固定系统前缀"},
        {"role": "user", "content": "上一轮用户输入"},
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-prev", "name": "lookup", "arguments": {},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-prev", "content": "已完成",
        }]},
        {"role": "assistant", "content": "上一轮回答"},
        {"role": "user", "content": "新一轮运行时上下文"},
        {"role": "user", "content": "新一轮用户输入"},
    ])
    fresh = _history_cache_state(
        next_run.provider_projection(),
        provider=provider,
        api_format=api_format,
        model=model,
    )
    restored = CacheState.from_session_anchor(
        stored_anchor,
        provider=provider,
        api_format=api_format,
        model=model,
        strategy="multi",
    )
    carried = _history_cache_state(
        next_run.provider_projection(),
        restored,
        provider=provider,
        api_format=api_format,
        model=model,
    )

    assert stored_anchor == {
        "provider": provider,
        "api_format": api_format,
        "model": model,
        "strategy": "multi",
        "baseline_digest": previous_state.baseline_digest,
    }
    assert "上一轮用户输入" not in str(stored_anchor)
    assert fresh.anchor_indices == (5, 6)
    assert carried.anchor_indices == (1, 6)
    assert carried.baseline_digest == previous_state.baseline_digest


def test_anthropic_cache_anchor_is_discarded_when_model_changes():
    state = CacheState.from_session_anchor(
        {
            "provider": "minimax",
            "api_format": "anthropic",
            "model": "old-model",
            "strategy": "multi",
            "baseline_digest": "fingerprint",
        },
        provider="minimax",
        api_format="anthropic",
        model="new-model",
        strategy="multi",
    )

    assert not state.baseline_digest


def test_diagnostics_reports_first_wire_difference_without_body():
    before = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{"role": "assistant", "content": "history"}],
        current_batch=[{"role": "user", "content": "old"}, {"role": "system", "content": "time"}],
    )
    after = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{"role": "assistant", "content": "history"}],
        current_batch=[{"role": "user", "content": "new"}, {"role": "system", "content": "time"}],
    )
    previous = before.provider_projection().to_messages()
    result = request_diagnostics(
        after, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
        previous_messages=previous,
    )
    assert result["first_diff_index"] == 2
    assert result["first_diff"]["previous"]["shape"]["role"] == "user"
    assert result["first_diff"]["current"]["shape"]["role"] == "user"
    assert result["first_diff"]["current"]["cumulative_token_estimate"] > 0
    assert result["first_diff"]["reason"] == "content_changed"
    assert "old" not in str(result)
    assert "new" not in str(result)


def test_diagnostics_classifies_summary_wrapper_change_without_logging_body():
    before = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{"role": "user", "content": "<compacted-summary>\n摘要\n</compacted-summary>"}],
        current_batch=[{"role": "user", "content": "当前"}],
    )
    after = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{"role": "user", "content": "## 早前对话摘要\n摘要"}],
        current_batch=[{"role": "user", "content": "当前"}],
    )
    result = request_diagnostics(
        after, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
        previous_messages=before.provider_projection().to_messages(),
    )

    assert result["first_diff_index"] == 1
    assert result["first_diff"]["reason"] == "wrapper_changed"
    assert result["first_diff"]["previous"]["shape"]["representation"] == "compacted-summary"
    assert result["first_diff"]["current"]["shape"]["representation"] == "legacy-summary-header"
    assert result["prefix_integrity"]["stable"] is False
    assert "摘要" not in str(result)


def test_ten_runs_keep_fixed_sections_stable_while_tail_changes():
    digests = []
    for index in range(10):
        messages = build_messages(
            fixed_parts=[{"role": "system", "content": "stable"}],
            history=[{"role": "assistant", "content": "history"}],
            current_batch=[
                {"role": "user", "content": f"message-{index}"},
                {"role": "system", "content": f"time-{index}"},
            ],
        )
        digests.append(messages.canonical_context.diagnostics())
    assert len({item["section_digests"]["static_system"] for item in digests}) == 1
    assert len({item["section_digests"]["canonical_history"] for item in digests}) == 1
    assert len({item["section_digests"]["current_turn"] for item in digests}) == 10


def test_diagnostics_never_include_context_body_or_attachment_url():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{
            "role": "user",
            "content": "用户私密正文",
            "files": [{"attach_id": "att-1", "url": "https://secret.invalid/signed"}],
        }],
        current_batch=[
            {"role": "user", "content": "当前私密问题"},
            {"role": "system", "content": "动态私密信息"},
        ],
    )
    result = request_diagnostics(
        messages, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
    )
    rendered = str(result)
    assert "用户私密正文" not in rendered
    assert "当前私密问题" not in rendered
    assert "动态私密信息" not in rendered
    assert "signed" not in rendered


def test_openai_request_diagnostics_report_cleaned_provider_history():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{"role": "tool", "tool_call_id": "stale", "content": "private orphan"}],
        current_batch=[{"role": "user", "content": "current"}],
    )
    result = request_diagnostics(
        messages,
        system_text="stable",
        tools=[],
        adapter=FakeAdapter(),
        model="test",
        api_format="openai",
    )

    assert result["wire_message_count"] == 2
    assert [item["shape"]["role"] for item in result["wire_message_diagnostics"]] == [
        "system", "user",
    ]
    assert result["provider_history_sanitization"] == {
        "applied": True,
        "changed": True,
        "removed_messages": 1,
        "modified_messages": 0,
        "first_changed_index": 1,
    }
    assert "private orphan" not in str(result)


def test_diagnostics_has_no_separate_tail_boundary():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{"role": "assistant", "content": "history"}],
        current_batch=[
            {"role": "user", "content": "current"},
            {"role": "system", "content": "volatile"},
        ],
    )
    result = request_diagnostics(
        messages, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
    )
    assert result["wire_message_count"] == 4
    assert result["wire_conversation_message_count"] == 4
    assert result["wire_turn_batch_count"] == 0
    assert "volatile" not in str(result)


def test_tool_continuation_promotes_tail_without_reordering_cache_prefix():
    messages = MessageArea.from_canonical_messages(
        [
            {"role": "system", "content": "stable"},
            {"role": "user", "content": "之前的请求"},
            {"role": "assistant", "content": "准备调用工具"},
        ],
    )
    first_wire = messages.provider_projection()
    old_prefix = [dict(item) for item in first_wire[:3]]

    # 模拟工具续轮：新增消息必须追加到当前 batch 后面。
    messages.append({
        "role": "assistant",
        "content": [{"type": "tool_call", "id": "call-1", "name": "search", "arguments": {}}],
    })
    messages.append({
        "role": "user",
        "content": [{"type": "tool_result", "tool_call_id": "call-1", "content": "结果"}],
    })
    second_wire = messages.provider_projection()

    assert second_wire[:3] == old_prefix
    assert second_wire.to_messages()[3:] == [
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call-1", "type": "function",
            "function": {"name": "search", "arguments": "{}"},
        }]},
        {"role": "tool", "tool_call_id": "call-1", "content": "结果"},
    ]


def test_history_cache_copy_preserves_dynamic_tail_boundary():
    prompt = MessageArea.from_canonical_messages([
        {"role": "system", "content": "稳定系统"},
        {"role": "user", "content": "上一轮问题"},
    ])
    prompt.set_dynamic_tail([
        reminder("当前时间：2026-08-30（星期日）"),
    ])

    cached, state = _with_single_history_cache(prompt.provider_projection())

    assert isinstance(cached, ProviderConversation)
    assert cached.dynamic_tail == prompt.dynamic_tail
    assert cached.conversation[0] == prompt.provider_projection().conversation[0]
    assert cached.conversation[1]["content"][0]["text"] == "上一轮问题"
    plan = _history_cache_state(cached, state)
    assert plan.stable_limit == 2
    assert all(index < plan.stable_limit for index in plan.anchor_indices)
    assert not any("cache_control" in block
                   for message in cached.dynamic_tail
                   for block in (message.get("content") or [])
                   if isinstance(block, dict))


def _prompt_with_volatile_image_and_dynamic_tail():
    prompt = MessageArea.from_canonical_messages([
        {"role": "system", "content": [{"type": "text", "text": "稳定 system"}]},
        {"role": "user", "content": "稳定历史"},
    ])
    prompt.append({"role": "user", "content": [{
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,AAAA"},
        }]})
    prompt.append({"role": "assistant", "content": "图片之后的真实对话"})
    prompt.set_dynamic_tail([{
        "role": "system",
        "content": [{
            "type": "text", "text": "本轮动态时间提醒",
            "cache_control": {"type": "ephemeral"},
        }],
    }])
    return prompt


def _assert_dynamic_tail_is_uncached(cached, original):
    assert isinstance(cached, ProviderConversation)
    assert len(cached.conversation) == len(original.provider_projection().conversation)
    assert cached.conversation[2]["content"][0]["type"] == "image_url"
    assert cached.conversation[3]["content"] == "图片之后的真实对话"
    assert cached.dynamic_tail == [{
        "role": "system",
        "content": [{"type": "text", "text": "本轮动态时间提醒"}],
    }]
    assert not any(
        "cache_control" in block
        for message in cached.dynamic_tail
        for block in (message.get("content") or [])
        if isinstance(block, dict)
    )


def test_anthropic_history_cache_keeps_conversation_after_cache_cutoff_and_excludes_tail():
    prompt = _prompt_with_volatile_image_and_dynamic_tail()

    cached, state = _with_history_cache(prompt.provider_projection())

    _assert_dynamic_tail_is_uncached(cached, prompt)
    plan = _history_cache_state(cached, state)
    assert plan.stable_limit == 2
    assert all(index < plan.stable_limit for index in plan.anchor_indices)
    assert "cache_control" in cached.conversation[1]["content"][0]


def test_openai_cache_markers_stay_in_conversation_and_are_removed_from_tail():
    prompt = _prompt_with_volatile_image_and_dynamic_tail()

    projected = prompt.provider_projection()
    system_cached = _with_system_cache_control(projected)
    cached, state = _with_single_history_cache(system_cached)

    _assert_dynamic_tail_is_uncached(cached, prompt)
    plan = _history_cache_state(cached, state, single_anchor=True)
    assert plan.stable_limit == 2
    assert all(index < plan.stable_limit for index in plan.anchor_indices)
    assert "cache_control" in cached.conversation[0]["content"][0]
    assert "cache_control" in cached.conversation[1]["content"][0]


def test_single_history_cache_replaces_old_anchor_instead_of_emitting_two():
    messages = MessageArea.from_canonical_messages([
        {"role": "system", "content": "stable"},
        {"role": "user", "content": "old"},
        {"role": "assistant", "content": "tool call"},
        {"role": "tool", "content": "tool result"},
        {"role": "user", "content": "latest"},
    ])

    cached, state = _with_single_history_cache(messages.provider_projection())

    assert state.latest_digest
    assert "cache_control" in cached[4]["content"][0]
    assert not isinstance(cached[1].get("content"), list)


def test_system_cache_control_does_not_mutate_history():
    messages = MessageArea.from_canonical_messages([
        {"role": "system", "content": [{"type": "text", "text": "stable"}]},
        {"role": "user", "content": "question"},
    ])

    outbound = _with_system_cache_control(messages.provider_projection())

    assert "cache_control" not in messages.provider_projection()[0]["content"][0]
    assert outbound[0]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_openai_system_messages_merge_at_request_boundary_without_mutating_history():
    messages = MessageArea.from_canonical_messages([
        {"role": "system", "content": "基础人格"},
        {"role": "system", "content": "session snapshot"},
        {"role": "user", "content": "当前问题"},
    ], fixed_prefix_size=2)
    messages.set_dynamic_tail([reminder("当前时间：当前时间")])

    outbound = merge_openai_system_messages(messages.provider_projection())

    assert isinstance(outbound, ProviderConversation)
    assert outbound.conversation == [
        {"role": "system", "content": "基础人格\n\n---\n\nsession snapshot"},
        {"role": "user", "content": "当前问题"},
    ]
    assert outbound.dynamic_tail == messages.dynamic_tail
    assert outbound.fixed_prefix_size == 1
    assert messages.provider_projection().to_messages() == [
        {"role": "system", "content": "基础人格"},
        {"role": "system", "content": "session snapshot"},
        {"role": "user", "content": "当前问题"},
        *messages.dynamic_tail,
    ]


def test_openai_system_messages_after_user_are_moved_into_one_leading_system():
    outbound = merge_openai_system_messages(ProviderConversation([
        {"role": "system", "content": "基础人格"},
        {"role": "user", "content": "历史问题"},
        {"role": "system", "content": "工具守卫"},
        {"role": "user", "content": "继续"},
    ]))

    assert [message["role"] for message in outbound] == ["system", "user", "user"]
    assert outbound[0]["content"] == "基础人格\n\n---\n\n工具守卫"
