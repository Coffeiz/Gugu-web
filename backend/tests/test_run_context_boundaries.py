from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent.context import audit, dynamic_tail, run_context
from agent.context.assembly import reminder
from agent.context.provider_history import render_anthropic_message_roles
from agent.providers import adapter_for
from agent.providers.message_utils import render_openai_request_history
from agent.rag import context as rag_context


def test_message_time_reminder_uses_message_timestamp_and_user_timezone():
    from zoneinfo import ZoneInfo

    reminder_message = dynamic_tail.message_time_reminder(
        datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc),
        ZoneInfo("Asia/Shanghai"),
    )

    assert reminder_message == {
        "role": "user",
        "content": (
            "[system-reminder]\n"
            "消息时间：2026-08-29 18:00\n"
            "[/system-reminder]"
        ),
    }


def test_historical_message_time_reminder_keeps_historical_label():
    assert dynamic_tail.message_time_reminder(
        datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc), timezone.utc,
    ) == {
        "role": "user",
        "content": (
            "[system-reminder]\n"
            "消息时间：2026-08-29 10:00\n"
            "[/system-reminder]"
        ),
    }


def test_time_message_marks_timestamp_as_reference_not_user_content(monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 14, 13, 10, tzinfo=tz)

    monkeypatch.setattr(dynamic_tail, "datetime", FixedDatetime)

    assert dynamic_tail.time_message(timezone.utc) == {
        "role": "user",
        "content": (
            "[system-reminder]\n"
            "仅供时间参考，不属于用户正文，请勿复述。\n"
            "当前时间：2026-09-14（星期一）13:10\n"
            "[/system-reminder]"
        ),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("use_anthropic", [True, False])
async def test_prepare_run_binds_rag_watermark_and_uses_message_time(
    monkeypatch, use_anthropic,
):
    observed_watermarks = []

    async def fake_rag(_req, _query, *, history, snapshot_text):
        observed_watermarks.append(rag_context.get_conversation_before_message_id())
        assert history == []
        assert snapshot_text == "snapshot"
        return {"tail": []}

    audit_calls = []
    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", fake_rag)
    monkeypatch.setattr(
        audit,
        "context_layout_audit",
        lambda **kwargs: audit_calls.append(kwargs),
    )

    legacy_time_context = SimpleNamespace(
        content_json=[{"type": "time-context", "text": "旧当前时间"}],
    )
    prepared = await run_context.prepare_run(
        system_prompt="stable system",
        snapshot_context="snapshot",
        history=[legacy_time_context],
        req=SimpleNamespace(message="旧文本"),
        user_tz=timezone.utc,
        strip_thinking=False,
        use_anthropic=use_anthropic,
        current_text="当前文本",
        images=[],
        media=[],
        model_cfg=SimpleNamespace(vision_detail="auto"),
        stance_text=None,
        snapshot_injection=None,
        user_message=SimpleNamespace(
            id=11,
            sent_at=datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc),
        ),
    )

    messages = prepared.anthr_messages if use_anthropic else prepared.oa_messages
    assert observed_watermarks == [11]
    assert rag_context.get_conversation_before_message_id() is None
    assert messages.dynamic_tail == []
    conversation_text = str(messages.conversation)
    current_time_text = "消息时间：2026-08-29 10:00"
    assert conversation_text.count(current_time_text) == 1
    assert conversation_text.index(current_time_text) < conversation_text.index("当前文本")
    assert "当前时间：" not in conversation_text
    assert "当前时间：" not in str(messages.canonical_batches)
    assert (prepared.anthr_initial_len if use_anthropic else prepared.oa_initial_len) == len(messages.conversation)
    provider_messages = (
        render_anthropic_message_roles(messages, None)
        if use_anthropic else render_openai_request_history(
            messages,
            adapter_for(SimpleNamespace(
                provider="openai", api_format="openai", model="test-model",
            )),
        )
    )
    assert provider_messages.dynamic_tail == []
    assert audit_calls[0]["history"] == []
