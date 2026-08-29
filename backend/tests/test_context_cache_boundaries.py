from agent.context.context_diagnostics import first_diff_index, request_diagnostics
from agent.context.context_assembly import build_messages
from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.assembly import PromptMessages


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
    assert result["wire_message_count"] == 3
    assert len(result["wire_message_diagnostics"]) == 3
    assert result["wire_role_sequence_digest"]
    assert result["wire_conversation_message_count"] == 3
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
    messages.remember_cache_anchor(2)

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
    assert messages.cache_anchor_indices == [2]
    assert messages.newly_appended(3) == second_wire[3:]
