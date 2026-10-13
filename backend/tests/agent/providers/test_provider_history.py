from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.context.history import build_history_parts
from agent.context.provider_history import (
    clean_persisted_history,
    prepare_session,
    render_anthropic_message_roles,
    sanitize_anthropic_branch_history,
    strip_thinking_blocks,
)
from agent.context.provider_conversation import ProviderConversation


class _Adapter:
    name = "minimax"

    def protocol_format(self, ai):
        return "anthropic"


def test_native_anthropic_renders_internal_system_reminder_as_user():
    messages = [
        {"role": "system", "content": "[system-reminder]\n时间\n[/system-reminder]"},
        {"role": "user", "content": "继续"},
    ]
    projection = ProviderConversation(messages)
    result = render_anthropic_message_roles(projection, SimpleNamespace(name="anthropic"))
    assert [item["role"] for item in result] == ["user", "user"]
    assert [item["role"] for item in render_anthropic_message_roles(
        projection, SimpleNamespace(name="minimax"))] == ["user", "user"]


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
    from agent.context.provider_conversation import ProviderConversation
    history = ProviderConversation([
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
    ])
    original = history.to_messages()

    cleaned = sanitize_anthropic_branch_history(history).to_messages()

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
    assert history.to_messages() == original


def test_anthropic_branch_history_drops_unanswered_tool_use():
    from agent.context.provider_conversation import ProviderConversation
    history = ProviderConversation([
        {"role": "user", "content": [{"type": "text", "text": "请求"}]},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "unfinished", "name": "demo", "input": {}},
        ]},
    ])

    assert sanitize_anthropic_branch_history(history).to_messages() == [
        {"role": "user", "content": [{"type": "text", "text": "请求"}]},
    ]


def test_anthropic_branch_history_drops_messages_that_only_contain_reasoning():
    from agent.context.provider_conversation import ProviderConversation
    history = ProviderConversation([
        {"role": "user", "content": "问题"},
        {"role": "assistant", "content": [
            {"type": "reasoning_content", "text": "provider-specific"},
        ]},
    ])

    assert sanitize_anthropic_branch_history(history).to_messages() == [
        {"role": "user", "content": "问题"},
    ]


@pytest.mark.asyncio
async def test_append_branch_sends_native_signed_thinking_without_changing_cached_prefix(monkeypatch):
    """主请求快照的原生推理块与签名必须原样进入追加请求，不能在反思前被清空。"""
    from agent.context import provider_runner

    native = {"type": "thinking", "thinking": "合成推理", "signature": "synthetic-signature"}
    redacted = {"type": "redacted_thinking", "data": "synthetic-redacted"}
    history = ProviderConversation([
        {"role": "user", "content": "查一下"},
        {"role": "assistant", "content": [native, redacted,
            {"type": "tool_use", "id": "paired", "name": "demo", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "paired", "content": "ok"}]},
        {"role": "assistant", "content": "完成"},
    ])
    original = history.to_messages()
    captured = {}

    async def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="{}")],
                               usage=SimpleNamespace(input_tokens=10, output_tokens=1))

    monkeypatch.setattr("agent.providers.build_anthropic_client",
                        lambda *_args: SimpleNamespace(messages=SimpleNamespace(create=create)))
    monkeypatch.setattr(provider_runner, "_record_usage", AsyncMock())
    ai = SimpleNamespace(provider="minimax", model="MiniMax-M3.1-Flash-Preview", max_tokens=128)
    await provider_runner._anthropic("稳定系统", "只做反思", ai, 128, history=history)

    assert captured["messages"][:3] == original[:3]
    assert captured["messages"][-1] == {"role": "user", "content": "只做反思"}
    assert history.to_messages() == original


def test_branch_pair_repair_keeps_native_thinking_and_removes_foreign_reasoning():
    """修复孤立工具结果时仍保留原生签名，外协议 reasoning_content 继续清理。"""
    native = {"type": "thinking", "thinking": "合成推理", "signature": "synthetic-signature"}
    history = ProviderConversation([
        {"role": "user", "content": [{"type": "text", "text": "继续"},
            {"type": "tool_result", "tool_use_id": "orphan", "content": "旧结果"}]},
        {"role": "assistant", "content": [native,
            {"type": "reasoning_content", "text": "foreign-reasoning"},
            {"type": "tool_use", "id": "paired", "name": "demo", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "paired", "content": "ok"}]},
    ])
    cleaned = sanitize_anthropic_branch_history(history).to_messages()
    assert cleaned[0]["content"] == [{"type": "text", "text": "继续"}]
    assert cleaned[1]["content"] == [native, {"type": "tool_use", "id": "paired", "name": "demo", "input": {}}]
    assert cleaned[2] == history.to_messages()[2]
