from types import SimpleNamespace

from agent.context.assembly import assemble_turn
from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.history import build_history_parts
from agent.context.provider_history import render_anthropic_message_roles
from agent.context.run_context import _history_stance_digest
from agent.security.sanitize import sanitize_messages


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
    rendered = render_events_for_provider(parts)

    assert rendered == [{
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
    live_messages = list(batch.provider_messages)
    assert live_messages[0]["content"][0]["type"] == "stance-context"
    live_openai = render_events_for_provider(live_messages)
    live_anthropic = render_anthropic_message_roles(
        render_events_for_provider(sanitize_messages(live_messages)), None,
    )

    persisted = SimpleNamespace(
        role="user",
        content="",
        content_json=[{
            "type": "stance-context",
            "digest": batch.provider_messages[0]["content"][0]["digest"],
            "text": f"[system-reminder]\n{stance}\n[/system-reminder]",
        }],
        sent_at=None,
        quoted_text=None,
    )
    restored_openai = render_events_for_provider(build_history_parts(
        [persisted], SimpleNamespace(), use_anthropic=False,
    ))
    restored_anthropic = render_anthropic_message_roles(
        render_events_for_provider(sanitize_messages(build_history_parts(
            [persisted], SimpleNamespace(), use_anthropic=True,
        ))), None,
    )

    expected = [{
        "role": "user",
        "content": [{
            "type": "text",
            "text": f"[system-reminder]\n{stance}\n[/system-reminder]",
        }],
    }]
    assert live_openai == restored_openai == expected
    assert live_anthropic == restored_anthropic == expected


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
