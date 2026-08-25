from agent.context.context_diagnostics import first_diff_index, request_diagnostics
from agent.context.context_assembly import build_messages


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
        current_user={"role": "user", "content": "hello"},
        dynamic_tail=[{"role": "system", "content": "time"}],
    )
    result = request_diagnostics(
        messages, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
        api_format="openai",
    )
    assert result["first_diff_index"] is None
    assert result["wire_message_count"] == 3
    assert "hello" not in str(result)
    assert "time" not in str(result)


def test_ten_runs_keep_fixed_sections_stable_while_tail_changes():
    digests = []
    for index in range(10):
        messages = build_messages(
            fixed_parts=[{"role": "system", "content": "stable"}],
            history=[{"role": "assistant", "content": "history"}],
            current_user={"role": "user", "content": f"message-{index}"},
            dynamic_tail=[{"role": "system", "content": f"time-{index}"}],
        )
        digests.append(messages.canonical_context.diagnostics())
    assert len({item["section_digests"]["static_system"] for item in digests}) == 1
    assert len({item["section_digests"]["canonical_history"] for item in digests}) == 1
    assert len({item["section_digests"]["dynamic_tail"] for item in digests}) == 10


def test_diagnostics_never_include_context_body_or_attachment_url():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "stable"}],
        history=[{
            "role": "user",
            "content": "用户私密正文",
            "files": [{"attach_id": "att-1", "url": "https://secret.invalid/signed"}],
        }],
        current_user={"role": "user", "content": "当前私密问题"},
        dynamic_tail=[{"role": "system", "content": "动态私密信息"}],
    )
    result = request_diagnostics(
        messages, system_text="stable", tools=[], adapter=FakeAdapter(), model="test",
    )
    rendered = str(result)
    assert "用户私密正文" not in rendered
    assert "当前私密问题" not in rendered
    assert "动态私密信息" not in rendered
    assert "signed" not in rendered
