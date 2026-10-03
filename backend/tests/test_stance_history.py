from types import SimpleNamespace

from agent.context.assembly import MessageArea, assemble_turn
from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.history import build_history_parts
from agent.context.provider_history import render_anthropic_message_roles
from agent.context.run_context import _history_stance_digest
from agent.security.sanitize import sanitize_messages
from agent.context.provider_conversation import ProviderConversation


def test_persisted_stance_context_replays_as_internal_reminder():
    message = SimpleNamespace(
        role="user",
        content="",
        content_json=[{
            "type": "stance-context",
            "text": "[system-reminder]\n## 本轮相处方式：查询\n[/system-reminder]",
        }],
        sent_at=None,
        quoted_text=None,
    )

    parts = build_history_parts([message], SimpleNamespace(), use_anthropic=False)
    rendered = render_events_for_provider(ProviderConversation(parts))

    assert rendered.to_messages() == [{
        "role": "user",
        "content": [{
            "type": "text",
            "text": "[system-reminder]\n## 本轮相处方式：查询\n[/system-reminder]",
        }],
    }]


def test_live_stance_projection_matches_next_run_history_projection():
    """首次注入与持久化回放必须使用相同的 provider content 包装。"""
    stance = "## 本轮相处方式：查询\n查准后直接回答。"
    batch, _ = assemble_turn(stance=stance)
    live_area = MessageArea.from_canonical_messages()
    live_area.append_batch(batch)
    live_area.configure_request(fixed_prefix=(), render_options={"api_format": "openai"})
    live_openai = live_area.provider_projection()
    live_area.configure_request(fixed_prefix=(), render_options={"api_format": "anthropic"})
    live_anthropic = live_area.provider_projection()

    persisted = SimpleNamespace(
        role="user",
        content="",
        content_json=[{
            "type": "stance-context",
            "digest": batch.canonical_messages[0]["content"][0]["digest"],
            "text": f"[system-reminder]\n{stance}\n[/system-reminder]",
        }],
        sent_at=None,
        quoted_text=None,
    )
    restored_area = MessageArea.from_restored([{
        "role": persisted.role,
        "content_json": persisted.content_json,
        "content": persisted.content,
    }])
    restored_area.configure_request(fixed_prefix=(), render_options={"api_format": "openai"})
    restored_openai = restored_area.provider_projection()
    restored_area.configure_request(fixed_prefix=(), render_options={"api_format": "anthropic"})
    restored_anthropic = restored_area.provider_projection()

    expected = [{
        "role": "user",
        "content": [{
            "type": "text",
            "text": f"[system-reminder]\n{stance}\n[/system-reminder]",
        }],
    }]
    assert live_openai.to_messages() == restored_openai.to_messages() == expected
    assert live_anthropic.to_messages() == restored_anthropic.to_messages() == expected


def test_history_stance_digest_uses_persisted_event_before_session_state():
    persisted = SimpleNamespace(
        content_json=[{
            "type": "stance-context",
            "digest": "first-digest",
            "text": "[system-reminder]\n## 本轮相处方式：查询\n[/system-reminder]",
        }]
    )
    computed = SimpleNamespace(
        content_json=[{
            "type": "stance-context",
            "text": "[system-reminder]\n## 本轮相处方式：执行\n[/system-reminder]",
        }]
    )

    assert _history_stance_digest([persisted]) == "first-digest"
    assert _history_stance_digest([computed])
