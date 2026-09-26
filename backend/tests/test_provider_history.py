from types import SimpleNamespace

from agent.context.history import build_history_parts
from agent.context.provider_history import (
    clean_persisted_history,
    prepare_session,
    render_anthropic_message_roles,
    sanitize_anthropic_branch_history,
    strip_thinking_blocks,
)


class _Adapter:
    name = "minimax"

    def protocol_format(self, ai):
        return "anthropic"


def test_native_anthropic_renders_internal_system_reminder_as_user():
    messages = [
        {"role": "system", "content": "[system-reminder]\n时间\n[/system-reminder]"},
        {"role": "user", "content": "继续"},
    ]
    result = render_anthropic_message_roles(messages, SimpleNamespace(name="anthropic"))
    assert [item["role"] for item in result] == ["user", "user"]
    assert [item["role"] for item in render_anthropic_message_roles(
        messages, SimpleNamespace(name="minimax"))] == ["user", "user"]


def test_strip_thinking_blocks_keeps_text_and_tools():
    blocks = [
        {"type": "thinking", "thinking": "signed"},
        {"type": "text", "text": "回答"},
        {"type": "tool_use", "id": "t1", "name": "pwd", "input": {}},
    ]
    assert strip_thinking_blocks(blocks) == blocks[1:]


def test_prepare_session_only_marks_change_once(monkeypatch):
    monkeypatch.setattr("agent.providers.adapter_for", lambda ai: _Adapter())
    session = SimpleNamespace(id=1, history_provider=None, history_api_format=None)
    ai = SimpleNamespace()
    _, first = prepare_session(session, ai)
    _, second = prepare_session(session, ai)
    assert first is True
    assert second is False
    assert (session.history_provider, session.history_api_format) == ("minimax", "anthropic")


def test_history_thinking_cleanup_is_send_boundary_only():
    message = SimpleNamespace(
        role="assistant",
        content_json=[
            {"type": "thinking", "thinking": "signed"},
            {"type": "text", "text": "保留"},
        ],
        sent_at=None,
    )
    request = SimpleNamespace()
    cleaned = build_history_parts(
        [message], request, use_anthropic=True, strip_thinking=True)
    original = build_history_parts([message], request, use_anthropic=True)
    assert cleaned == [{"role": "assistant", "content": [{"type": "text", "text": "保留"}]}]
    assert original[0]["content"][0]["type"] == "thinking"


def test_clean_persisted_history_removes_old_blocks_once():
    message = SimpleNamespace(content_json=[
        {"type": "thinking", "thinking": "signed"},
        {"type": "text", "text": "保留"},
    ])
    assert clean_persisted_history([message]) == 1
    assert message.content_json == [{"type": "text", "text": "保留"}]
    assert clean_persisted_history([message]) == 0


def test_anthropic_branch_history_removes_reasoning_and_orphan_tool_results():
    history = [
        {"role": "user", "content": [{"type": "text", "text": "旧问题"}]},
        {"role": "assistant", "content": [
            {"type": "text", "text": "回答"},
            {"type": "reasoning_content", "text": "provider-specific"},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "orphan", "content": "旧结果"},
            {"type": "text", "text": "继续"},
        ]},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "paired", "name": "demo", "input": {}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "paired", "content": "ok"},
        ]},
    ]
    original = [dict(message) for message in history]

    cleaned = sanitize_anthropic_branch_history(history)

    assert cleaned == [
        {"role": "user", "content": [{"type": "text", "text": "旧问题"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "回答"}]},
        {"role": "user", "content": [{"type": "text", "text": "继续"}]},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "paired", "name": "demo", "input": {}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "paired", "content": "ok"},
        ]},
    ]
    assert history == original


def test_anthropic_branch_history_drops_unanswered_tool_use():
    history = [
        {"role": "user", "content": [{"type": "text", "text": "请求"}]},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "unfinished", "name": "demo", "input": {}},
        ]},
    ]

    assert sanitize_anthropic_branch_history(history) == [
        {"role": "user", "content": [{"type": "text", "text": "请求"}]},
    ]


def test_anthropic_branch_history_drops_messages_that_only_contain_reasoning():
    history = [
        {"role": "user", "content": "问题"},
        {"role": "assistant", "content": [
            {"type": "reasoning_content", "text": "provider-specific"},
        ]},
    ]

    assert sanitize_anthropic_branch_history(history) == [
        {"role": "user", "content": "问题"},
    ]
