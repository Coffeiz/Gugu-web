"""v3 准入的快照装载、无频率额度与无明文诊断回归。"""
import json
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
async def test_recent_attention_messages_read_only_the_scoped_stream(monkeypatch):
    from app.core import redis as redis_module

    event_id = "1761746401000-2"
    scope = runtime.AttentionMessage.from_payload(event_id, _payload(event_id, "问题"))
    scoped_key = redis_module.attention_scope_stream_key("qq", "bot-1", "group-1")
    row_payload = {
        **_payload("ignored", "邻近群消息"),
        "channel_id": "bot-1", "chat_id": "group-1", "chat_type": "group",
    }

    class Redis:
        def __init__(self, started_at):
            self.started_at = started_at
            self.reads = []

        async def get(self, key):
            assert key == redis_module.attention_scope_start_key("qq", "bot-1", "group-1")
            return self.started_at

        async def xrange(self, key, *, min, max):
            self.reads.append((key, min, max))
            return [(event_id, {"data": json.dumps(row_payload)})]

    redis = Redis("1761745800000")
    monkeypatch.setattr(redis_module, "get_redis", lambda: redis)
    messages, complete, truncated = await runtime._recent_stream_messages(
        scope=scope, cutoff_ms=1761745800000, watermark_ms=1761746402000,
        current_ids=set(),
    )

    assert [message.raw_text for message in messages] == ["邻近群消息"]
    assert complete is True and truncated is False
    assert redis.reads == [(scoped_key, "1761745800000-0", "1761746402000-9999999")]

    redis.started_at = "1761746000000"
    _messages, complete, truncated = await runtime._recent_stream_messages(
        scope=scope, cutoff_ms=1761745800000, watermark_ms=1761746402000,
        current_ids=set(),
    )
    assert complete is False and truncated is True


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


@pytest.mark.asyncio
async def test_pending_resume_scores_only_exact_trigger_at_original_time(monkeypatch):
    anchor_id = "1761746401000-2"
    seen = {}
    future_message = runtime.AttentionMessage.from_payload(
        "1761746402000-3",
        {
            "platform": "qq", "bot_id": "bot-1", "chat_id": "group-1",
            "platform_user_id": "member-2", "text": "later answer",
            "sender_is_bot": False,
        },
    )

    async def snapshot(_session_id, messages):
        seen["input_messages"] = messages
        return AttentionSnapshot(messages=(future_message,), complete=True)

    async def no_transcription(*_args, **_kwargs):
        return {}

    async def resolve_aliases(*_args, **_kwargs):
        return ()

    async def decide(message, snapshot_value, _mode, *, bot_aliases):
        seen["message"] = message
        seen["snapshot"] = snapshot_value
        return runtime.AttentionDecision(
            AttentionKind.PROACTIVE, 90, 65, ("scene_ask",),
            state="COLD", scene_type="ASK", scene_score=.9,
        ), None

    async def cancel(_payload):
        seen["cancelled"] = True

    monkeypatch.setattr(runtime, "load_attention_snapshot", snapshot)
    monkeypatch.setattr(runtime, "transcribe_voice_for_attention", no_transcription)
    monkeypatch.setattr(runtime, "_resolve_bot_aliases", resolve_aliases)
    monkeypatch.setattr(runtime, "_decide_attention_message", decide)
    monkeypatch.setattr("agent.im.auto_reply.pending_ask.cancel_pending_ask", cancel)
    payload = {
        **_payload(anchor_id, "为啥这个项目没有 issue？"),
        "_pending_ask_resume": True,
        "_pending_ask_trigger_event_id": anchor_id,
        "_batch_messages": [
            {
                "event_id": "1761746400000-1", "text": "@someone 这个 fork 是你的吗？",
                "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
                "platform_user_id": "member-1", "mentions_other_member": True,
            },
            {
                "event_id": anchor_id, "text": "为啥这个项目没有 issue？",
                "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
                "platform_user_id": "member-1",
            },
        ],
    }
    request = SimpleNamespace(session_id=12, inbound_batch_key="resume-batch")

    should_run, decision = await runtime.evaluate_group_attention(request, payload)

    assert should_run is True
    assert decision.scene_type == "ASK"
    assert [item.event_id for item in seen["input_messages"]] == [anchor_id]
    assert seen["message"].event_id == anchor_id
    assert seen["message"].event_received_ms == 1761746401000
    assert [item.event_id for item in seen["snapshot"].messages] == []
    assert payload["_attention_source_event_ids"] == [anchor_id]
    assert payload["_attention_decision_kind"] == "proactive"
    assert seen["cancelled"] is True


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
    assert record["attention_version"] == "attention-v3.0.7"
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
