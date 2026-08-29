from types import SimpleNamespace

from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.history import build_history_parts
from agent.context.run_context import _history_stance_digest


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
