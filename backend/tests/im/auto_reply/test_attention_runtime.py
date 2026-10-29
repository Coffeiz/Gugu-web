"""自主模式沿原 Agent 路径放行，不读取评分上下文或预留注意力预算。"""
from types import SimpleNamespace

import pytest

from agent.im.auto_reply.attention import AttentionKind
from agent.im.auto_reply import runtime


@pytest.mark.asyncio
async def test_autonomous_mode_bypasses_snapshot_and_budget(monkeypatch):
    async def unexpected_snapshot(*_args, **_kwargs):
        raise AssertionError("autonomous mode must not load scoring history")

    async def unexpected_reservation(*_args, **_kwargs):
        raise AssertionError("autonomous mode must not reserve attention budget")

    monkeypatch.setattr(runtime, "load_attention_snapshot", unexpected_snapshot)
    monkeypatch.setattr("agent.im.auto_reply.budget.reserve_proactive_slot", unexpected_reservation)
    request = SimpleNamespace(session_id=None, inbound_batch_key=None)
    payload = {
        "platform": "qq",
        "channel_id": "bot-1",
        "chat_id": "group-1",
        "chat_type": "group",
        "group_attention_mode": "autonomous",
        "event_id": "1761746400000-3",
        "platform_user_id": "member-1",
        "text": "哈哈",
    }

    should_run, decision, reservation_id = await runtime.evaluate_group_attention(
        request, payload
    )

    assert should_run is True
    assert decision is not None
    assert decision.kind is AttentionKind.ALLOW_RUN
    assert decision.score is None
    assert decision.threshold is None
    assert decision.reasons == ("autonomous_bypass",)
    assert reservation_id is None
    assert request.session_id is None


def test_proactive_acceptance_facts_do_not_replace_platform_reply_index():
    from agent.im.auto_reply.attention import BotReplyFact

    platform_fact = BotReplyFact("message-1", 100, "member-1", True)

    merged = runtime.merge_proactive_reply_facts(
        {"message-1": platform_fact}, (("run-1", 200),),
    )

    assert merged["message-1"] is platform_fact
    assert merged["attention-run:run-1"] == BotReplyFact(
        "attention-run:run-1", 200, None, True, proactive=True,
    )


def test_only_explicitly_rejected_gateway_receipts_release_attention_budget():
    from agent.im.dispatch_finalization import _verified_budget_outcome

    payload = {
        "_attention_track_delivery": True,
        "_attention_outbound_receipts": [{"status": "FAILED_CONFIRMED"}],
    }
    assert _verified_budget_outcome(payload, "UNKNOWN") == "FAILED_CONFIRMED"
    payload["_attention_outbound_receipts"] = [{"status": "UNKNOWN"}]
    assert _verified_budget_outcome(payload, "FAILED_CONFIRMED") == "UNKNOWN"
    payload["_attention_outbound_receipts"] = [
        {"status": "FAILED_CONFIRMED"}, {"status": "ACCEPTED"},
    ]
    assert _verified_budget_outcome(payload, "UNKNOWN") == "ACCEPTED"


def test_attention_audit_records_mode_version_and_run_entry_without_message_content(monkeypatch):
    import json

    from agent.im.dispatch import _log_attention_decision
    from agent.im.auto_reply.attention import AttentionDecision

    captured = []
    monkeypatch.setattr(
        "app.core.redaction.diag_log_raw",
        lambda where, text: captured.append((where, text)),
    )

    _log_attention_decision(
        AttentionDecision(
            AttentionKind.ALLOW_RUN, None, None, ("autonomous_bypass",)
        ),
        mode="autonomous",
        source_event_count=2,
        should_run=True,
        config_version=7,
    )

    assert len(captured) == 1
    where, serialized = captured[0]
    record = json.loads(serialized)
    assert where == "agent.im.attention.decision"
    assert record["attention_version"] == "attention-v1.4"
    assert record["mode"] == "autonomous"
    assert record["config_version"] == 7
    assert record["actual_decision"] == "ALLOW_RUN"
    assert record["reason_codes"] == ["autonomous_bypass"]
    assert record["run_entered"] is True
    assert record["score"] is None
    assert record["score_breakdown"] is None
    assert record["threshold"] is None
    assert "message" not in serialized

    captured.clear()
    _log_attention_decision(
        AttentionDecision(
            AttentionKind.PROACTIVE,
            70,
            70,
            ("P02_substantive_question", "P03_concrete_context"),
            (("P02_substantive_question", 30), ("P03_concrete_context", 15)),
        ),
        mode="natural",
        source_event_count=1,
        should_run=True,
        config_version=8,
        snapshot_complete=True,
        reservation={"kind": "proactive"},
    )
    record = json.loads(captured[0][1])
    assert record["snapshot_complete"] is True
    assert record["score_breakdown"] == {
        "P02_substantive_question": 30,
        "P03_concrete_context": 15,
    }
    assert record["budget_kind"] == "proactive"


def test_passive_completion_logs_only_hashed_batch_receipt(monkeypatch):
    import json

    from agent.im.dispatch import _log_attention_passive_receipt

    captured = []
    monkeypatch.setattr(
        "app.core.redaction.diag_log_raw",
        lambda where, text: captured.append((where, text)),
    )
    _log_attention_passive_receipt(
        mode="natural", config_version=3, batch_key="synthetic-batch-key",
        source_event_count=2,
    )

    where, serialized = captured[0]
    record = json.loads(serialized)
    assert where == "agent.im.attention.passive_receipt"
    assert record["persistence_receipt"] == "completed"
    assert record["config_version"] == 3
    assert record["batch_key_hash"] != "synthetic-batch-key"
    assert "synthetic-batch-key" not in serialized


@pytest.mark.asyncio
async def test_recent_stream_snapshot_includes_unpersisted_same_group_messages_and_proves_window(
    monkeypatch,
):
    import json

    cutoff = 1_761_746_400_000
    rows = [
        (f"{cutoff - 1_000}-0", {"data": json.dumps({"platform": "qq", "channel_id": "bot-1", "chat_id": "group-1", "chat_type": "group", "text": "old"})}),
        (f"{cutoff + 1_000}-0", {"data": json.dumps({"platform": "qq", "channel_id": "bot-1", "chat_id": "group-1", "chat_type": "group", "platform_user_id": "member-2", "sender_is_bot": False, "text": "Redis 尚未落库的消息"})}),
        (f"{cutoff + 2_000}-0", {"data": json.dumps({"platform": "qq", "channel_id": "bot-1", "chat_id": "another-group", "chat_type": "group", "platform_user_id": "member-x", "sender_is_bot": False, "text": "其他群消息"})}),
    ]

    class FakeRedis:
        async def xrange(self, _stream, *, min, max, count=None):
            if count == 1:
                return rows[:1]
            return [row for row in rows if min <= row[0] <= max]

    monkeypatch.setattr("app.core.redis.get_redis", lambda: FakeRedis())
    scope = SimpleNamespace(platform="qq", bot_id="bot-1", group_id="group-1")
    history, complete, truncated = await runtime._recent_stream_messages(
        scope=scope,
        cutoff_ms=cutoff,
        watermark_ms=cutoff + 60_000,
        current_ids=set(),
    )

    assert complete is True
    assert truncated is False
    assert len(history) == 1
    assert history[0].raw_text == "Redis 尚未落库的消息"
    assert history[0].sender_id == "member-2"


@pytest.mark.asyncio
async def test_recent_stream_snapshot_is_incomplete_when_stream_trimmed_past_window(monkeypatch):
    cutoff = 1_761_746_400_000

    class FakeRedis:
        async def xrange(self, _stream, *, min, max, count=None):
            return [(f"{cutoff + 1_000}-0", {"data": "{}"})]

    monkeypatch.setattr("app.core.redis.get_redis", lambda: FakeRedis())
    scope = SimpleNamespace(platform="qq", bot_id="bot-1", group_id="group-1")
    history, complete, truncated = await runtime._recent_stream_messages(
        scope=scope,
        cutoff_ms=cutoff,
        watermark_ms=cutoff + 60_000,
        current_ids=set(),
    )

    assert history == []
    assert complete is False
    assert truncated is True


@pytest.mark.asyncio
async def test_soft_continuation_requires_scoped_server_anchor_and_reserves_once(monkeypatch):
    from agent.im.auto_reply import budget
    from agent.im.auto_reply.attention import AttentionKind, AttentionSnapshot

    async def snapshot(_session_id, messages):
        return AttentionSnapshot(
            complete=False, watermark_ms=1_761_746_400_000,
            messages=messages, batch_messages=messages,
        )

    redis = object()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    monkeypatch.setattr(runtime, "load_attention_snapshot", snapshot)
    payload = {
        "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
        "chat_type": "group", "group_attention_mode": "natural",
        "_inbound_batch_key": "stable-run", "event_id": "1761746400000-3",
        "platform_user_id": "member-1", "sender_is_bot": False,
        "text": "这是修复后的错误截图说明", "attachments": [],
    }
    request = SimpleNamespace(session_id=12, inbound_batch_key="stable-run")

    async def expected_anchor(_redis, **kwargs):
        assert _redis is redis and kwargs["sender_id"] == "member-1"
        return "accepted-material-request"

    async def expected_reserve(_redis, **kwargs):
        assert _redis is redis
        assert kwargs["run_id"] == "stable-run"
        assert kwargs["anchor_id"] == "accepted-material-request"
        return True

    monkeypatch.setattr(budget, "get_soft_anchor", expected_anchor)
    monkeypatch.setattr(budget, "reserve_soft_slot", expected_reserve)
    should_run, decision, reservation = await runtime.evaluate_group_attention(request, payload)

    assert should_run is True
    assert decision is not None and decision.kind is AttentionKind.SOFT_CONTINUE
    assert reservation == {
        "kind": "soft", "run_id": "stable-run", "sender_id": "member-1",
        "anchor_id": "accepted-material-request",
    }


@pytest.mark.asyncio
async def test_one_hard_rejected_message_does_not_hide_another_open_candidate_in_batch(monkeypatch):
    from agent.im.auto_reply import budget
    from agent.im.auto_reply.attention import AttentionSnapshot

    async def snapshot(_session_id, messages):
        return AttentionSnapshot(
            complete=True, watermark_ms=1_761_746_400_000,
            messages=messages, batch_messages=messages,
        )

    async def no_anchor(*_args, **_kwargs):
        return None

    async def reserved(*_args, **kwargs):
        assert kwargs["mode"] == "natural"
        return True

    monkeypatch.setattr("app.core.redis.get_redis", lambda: object())
    monkeypatch.setattr(runtime, "load_attention_snapshot", snapshot)
    monkeypatch.setattr(budget, "get_soft_anchor", no_anchor)
    monkeypatch.setattr(budget, "reserve_proactive_slot", reserved)
    payload = {
        "platform": "qq", "channel_id": "bot-1", "chat_id": "group-1",
        "chat_type": "group", "group_attention_mode": "natural",
        "_batch_messages": [
            {
                "event_id": "1761746400000-1", "platform_user_id": "member-a",
                "sender_is_bot": False, "text": "", "media_only": True,
                "media_kinds": ["sticker"], "processable_media": True,
            },
            {
                "event_id": "1761746400001-0", "platform_user_id": "member-b",
                "sender_is_bot": False, "text": "有人知道 FastAPI 连接池报错怎么解决吗？",
            },
        ],
    }
    request = SimpleNamespace(session_id=12, inbound_batch_key="mixed-batch")

    should_run, decision, reservation = await runtime.evaluate_group_attention(request, payload)

    assert should_run is True
    assert decision is not None and decision.kind is AttentionKind.PROACTIVE
    assert "P01_group_broadcast_request" in decision.reasons
    assert reservation == {
        "kind": "proactive", "run_id": "mixed-batch", "sender_id": None,
        "anchor_id": None,
    }


async def _soft_anchor(*_args, **_kwargs):
    return "unused-anchor"


async def _reserve_soft(*_args, **_kwargs):
    return True
