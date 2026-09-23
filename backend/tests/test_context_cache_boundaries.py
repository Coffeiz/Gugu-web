from agent.context.context_diagnostics import first_diff_index, request_diagnostics
from agent.context.context_assembly import build_messages
from agent.context.canonical_tool_history import render_events_for_provider
from agent.loop_drivers import (
    _history_cache_state,
    _with_history_cache,
    _with_single_history_cache,
)
from agent.providers.message_utils import (
    _with_system_cache_control,
    merge_openai_system_messages,
)
from agent.context.assembly import PromptMessages, reminder


class FakeAdapter:
    name = "deepseek"

    def supports_active_cache(self, model):
        return True

    def supports_explicit_cache(self, model):
        return False

    def uses_single_history_cache_anchor(self, model):
        return False

    def render_history(self, messages):
        return list(messages)


def test_first_diff_is_structural_and_diagnostics_are_digest_only():
    before = [{"role": "user", "content": "old"}, {"role": "system", "content": "time"}]
    after = [{"role": "user", "content": "old"}, {"role": "system", "content": "new"}]
    assert first_diff_index(before, after) == 1


def test_provider_projection_keeps_cache_state_outside_prompt_messages():
    source = PromptMessages([
        {"role": "user", "content": [{"type": "text", "text": "历史"}]},
        {"role": "user", "content": [{"type": "text", "text": "本轮请求"}]},
    ])

    first_projection = render_events_for_provider(source)
    first_cached, state = _with_history_cache(first_projection)
    assert not hasattr(source, "cache_anchor_indices")

    source.append({"role": "assistant", "content": [{"type": "tool_use", "name": "weather"}]})
    source.append({"role": "user", "content": [{"type": "tool_result", "content": "ok"}]})
    second_projection = render_events_for_provider(source)
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
    previous = list(before)
    current = list(after)
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
        previous_messages=list(before),
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
    messages = PromptMessages(
        [
            {"role": "system", "content": "stable"},
            {"role": "user", "content": "之前的请求"},
            {"role": "assistant", "content": "准备调用工具"},
        ],
    )
    first_wire = render_events_for_provider(messages)
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
    second_wire = render_events_for_provider(messages)

    assert second_wire[:3] == old_prefix
    assert messages.newly_appended(3) == second_wire[3:]


def test_history_cache_copy_preserves_dynamic_tail_boundary():
    prompt = PromptMessages([
        {"role": "system", "content": "稳定系统"},
        {"role": "user", "content": "上一轮问题"},
    ])
    prompt.set_dynamic_tail([
        reminder("当前时间：2026-08-30（星期日）"),
    ])

    cached, state = _with_single_history_cache(render_events_for_provider(prompt))

    assert isinstance(cached, PromptMessages)
    assert cached.dynamic_tail == prompt.dynamic_tail
    assert cached.conversation[0] == prompt.conversation[0]
    assert cached.conversation[1]["content"][0]["text"] == "上一轮问题"
    plan = _history_cache_state(cached, state)
    assert plan.stable_limit == 2
    assert all(index < plan.stable_limit for index in plan.anchor_indices)
    assert not any("cache_control" in block
                   for message in cached.dynamic_tail
                   for block in (message.get("content") or [])
                   if isinstance(block, dict))


def _prompt_with_volatile_image_and_dynamic_tail():
    prompt = PromptMessages([
        {"role": "system", "content": [{"type": "text", "text": "稳定 system"}]},
        {"role": "user", "content": "稳定历史"},
        {"role": "user", "content": [{
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
        }]},
        {"role": "assistant", "content": "图片之后的真实对话"},
    ])
    prompt.set_dynamic_tail([{
        "role": "system",
        "content": [{
            "type": "text", "text": "本轮动态时间提醒",
            "cache_control": {"type": "ephemeral"},
        }],
    }])
    return prompt


def _assert_dynamic_tail_is_uncached(cached, original):
    assert isinstance(cached, PromptMessages)
    assert len(cached.conversation) == len(original.conversation)
    assert cached.conversation[2]["content"][0]["type"] == "image"
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

    cached, state = _with_history_cache(render_events_for_provider(prompt))

    _assert_dynamic_tail_is_uncached(cached, prompt)
    plan = _history_cache_state(cached, state)
    assert plan.stable_limit == 2
    assert all(index < plan.stable_limit for index in plan.anchor_indices)
    assert "cache_control" in cached.conversation[1]["content"][0]


def test_openai_cache_markers_stay_in_conversation_and_are_removed_from_tail():
    prompt = _prompt_with_volatile_image_and_dynamic_tail()

    projected = render_events_for_provider(prompt)
    system_cached = _with_system_cache_control(projected)
    cached, state = _with_single_history_cache(system_cached)

    _assert_dynamic_tail_is_uncached(cached, prompt)
    plan = _history_cache_state(cached, state, single_anchor=True)
    assert plan.stable_limit == 2
    assert all(index < plan.stable_limit for index in plan.anchor_indices)
    assert "cache_control" in cached.conversation[0]["content"][0]
    assert "cache_control" in cached.conversation[1]["content"][0]


def test_single_history_cache_replaces_old_anchor_instead_of_emitting_two():
    messages = PromptMessages([
        {"role": "system", "content": "stable"},
        {"role": "user", "content": "old"},
        {"role": "assistant", "content": "tool call"},
        {"role": "tool", "content": "tool result"},
        {"role": "user", "content": "latest"},
    ])

    cached, state = _with_single_history_cache(messages)

    assert state.latest_digest
    assert "cache_control" in cached[4]["content"][0]
    assert not isinstance(cached[1].get("content"), list)


def test_system_cache_control_does_not_mutate_history():
    messages = PromptMessages([
        {"role": "system", "content": [{"type": "text", "text": "stable"}]},
        {"role": "user", "content": "question"},
    ])

    outbound = _with_system_cache_control(messages)

    assert "cache_control" not in messages[0]["content"][0]
    assert outbound[0]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_openai_system_messages_merge_at_request_boundary_without_mutating_history():
    messages = PromptMessages([
        {"role": "system", "content": "基础人格"},
        {"role": "system", "content": "session snapshot"},
        {"role": "user", "content": "当前问题"},
    ], fixed_prefix_size=2)
    messages.set_dynamic_tail([reminder("当前时间：当前时间")])

    outbound = merge_openai_system_messages(messages)

    assert isinstance(outbound, PromptMessages)
    assert outbound.conversation == [
        {"role": "system", "content": "基础人格\n\n---\n\nsession snapshot"},
        {"role": "user", "content": "当前问题"},
    ]
    assert outbound.dynamic_tail == messages.dynamic_tail
    assert outbound.fixed_prefix_size == 1
    assert list(messages) == [
        {"role": "system", "content": "基础人格"},
        {"role": "system", "content": "session snapshot"},
        {"role": "user", "content": "当前问题"},
        *messages.dynamic_tail,
    ]


def test_openai_system_messages_after_user_are_moved_into_one_leading_system():
    outbound = merge_openai_system_messages([
        {"role": "system", "content": "基础人格"},
        {"role": "user", "content": "历史问题"},
        {"role": "system", "content": "工具守卫"},
        {"role": "user", "content": "继续"},
    ])

    assert [message["role"] for message in outbound] == ["system", "user", "user"]
    assert outbound[0]["content"] == "基础人格\n\n---\n\n工具守卫"
