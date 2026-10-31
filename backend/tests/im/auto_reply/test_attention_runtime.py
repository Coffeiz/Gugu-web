"""v3 准入的快照装载、无频率额度与无明文诊断回归。"""
from types import SimpleNamespace

import pytest

from agent.im.auto_reply.attention import AttentionKind, AttentionSnapshot
from agent.im.auto_reply import runtime


def _payload(event_id: str, text: str, mode: str = "natural") -> dict:
    return {
        "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
        "chat_type": "group", "group_attention_mode": mode,
        "event_id": event_id, "platform_user_id": "member-1",
        "sender_is_bot": False, "text": text,
    }


@pytest.mark.asyncio
async def test_autonomous_keeps_safety_routes_without_loading_topic_snapshot(monkeypatch):
    async def unexpected_snapshot(*_args, **_kwargs):
        raise AssertionError("autonomous mode should not load a topic snapshot")

    monkeypatch.setattr(runtime, "load_attention_snapshot", unexpected_snapshot)
    request = SimpleNamespace(session_id=None, inbound_batch_key="autonomous-run")

    allowed, allowed_decision = await runtime.evaluate_group_attention(
        request, _payload("1761746400000-1", "普通陈述", "autonomous"),
    )
    rejected, rejected_decision = await runtime.evaluate_group_attention(
        request, {**_payload("1761746400001-1", "@其他人 好的", "autonomous"), "mentions_other_member": True},
    )

    assert allowed is True
    assert allowed_decision.kind is AttentionKind.ALLOW_RUN
    assert rejected is False
    assert rejected_decision.kind is AttentionKind.EXCLUDED


@pytest.mark.asyncio
async def test_scored_invitation_reaches_run_without_frequency_gate(monkeypatch):
    async def snapshot(_session_id, messages):
        return AttentionSnapshot(messages=messages, complete=True)

    async def no_transcription(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(runtime, "load_attention_snapshot", snapshot)
    monkeypatch.setattr(runtime, "transcribe_voice_for_attention", no_transcription)
    request = SimpleNamespace(session_id=12, inbound_batch_key="batch")

    first, first_decision = await runtime.evaluate_group_attention(
        request, _payload("1761746400000-1", "咕咕看吧"),
    )
    second, second_decision = await runtime.evaluate_group_attention(
        request, _payload("1761746400001-1", "咕咕看吧"),
    )

    assert first is second is True
    assert first_decision.score == second_decision.score == pytest.approx(92)
    assert first_decision.kind is second_decision.kind is AttentionKind.PROACTIVE


def test_attention_audit_records_v3_scores_without_plaintext(monkeypatch):
    import json

    from agent.im.dispatch import _log_attention_decision
    from agent.im.auto_reply.attention import AttentionDecision

    captured = []
    monkeypatch.setattr("app.core.redaction.diag_log_raw", lambda where, text: captured.append((where, text)))
    _log_attention_decision(
        AttentionDecision(
            AttentionKind.PROACTIVE, 92, 65, ("state_cold", "scene_call", "threshold_reached"),
            (("scene", .92), ("topic", 0.0)), state="COLD", scene_type="CALL", scene_score=.92,
            ask_raw_score=.9, ask_position_weight=.55, ask_adjusted_score=.495,
            ask_punctuation_weight=.65,
            ask_span_start=120, ask_span_end=132, capability_strength="weak",
            capability_span_start=40, capability_span_end=45, capability_position_weight=.72,
        ),
        mode="natural", source_event_count=1, should_run=True, config_version=7,
        snapshot_complete=True,
    )

    where, serialized = captured[0]
    record = json.loads(serialized)
    assert where == "agent.im.attention.decision"
    assert record["attention_version"] == "attention-v3.0.6"
    assert record["state"] == "COLD"
    assert record["scene_type"] == "CALL"
    assert record["scene_score"] == .92
    assert record["ask_raw_score"] == .9
    assert record["ask_position_weight"] == .55
    assert record["ask_punctuation_weight"] == .65
    assert record["ask_adjusted_score"] == .495
    assert record["ask_span_start"] == 120
    assert record["capability_strength"] == "weak"
    assert record["capability_position_weight"] == .72
    assert "text" not in record and "message" not in record
