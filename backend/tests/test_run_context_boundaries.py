from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent.context import audit, run_context
from agent.rag import context as rag_context


@pytest.mark.asyncio
@pytest.mark.parametrize("use_anthropic", [True, False])
async def test_prepare_run_binds_rag_watermark_and_keeps_current_time_provider_only(
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
    assert "当前时间：" in str(messages.dynamic_tail)
    assert "当前时间：" not in str(messages.conversation)
    assert (prepared.anthr_initial_len if use_anthropic else prepared.oa_initial_len) == len(messages.conversation)
    assert audit_calls[0]["history"] == []
