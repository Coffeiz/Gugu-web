"""群聊出站收据只记录平台接受事实，并按完整会话作用域索引。"""
import fakeredis.aioredis
import pytest

from agent.im.auto_reply.delivery import (
    begin_delivery,
    lookup_answer_for_source_event,
    lookup_bot_reply,
    settle_delivery,
)


@pytest.mark.asyncio
async def test_delivery_is_idempotent_and_indexes_each_accepted_platform_message():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    args = dict(
        delivery_id="delivery-1",
        platform="telegram",
        bot_id="bot-1",
        group_id="group-1",
        run_key="run-1",
        source_event_ids=["1761746400000-1"],
        answer_source_event_ids=["1761746400000-1"],
        recipient_sender_id="member-1",
        proactive=True,
        submitted_at_ms=1_000_000,
    )

    assert await begin_delivery(redis, **args) == "NEW"
    assert await begin_delivery(redis, **args) == "SUBMITTED"
    assert await settle_delivery(
        redis,
        delivery_id="delivery-1",
        platform="telegram",
        bot_id="bot-1",
        group_id="group-1",
        outcome="ACCEPTED",
        platform_message_ids=["message-a", "message-b"],
        answer_source_event_ids=["1761746400000-1"],
        accepted_at_ms=1_000_250,
    )

    first = await lookup_bot_reply(
        redis, platform="telegram", bot_id="bot-1", group_id="group-1",
        platform_message_id="message-a",
    )
    second = await lookup_bot_reply(
        redis, platform="telegram", bot_id="bot-1", group_id="group-1",
        platform_message_id="message-b",
    )
    assert first["status"] == second["status"] == "ACCEPTED"
    assert first["recipient_sender_id"] == "member-1"
    assert first["accepted_at_ms"] == "1000250"
    assert first["proactive"] == "1"
    answered = await lookup_answer_for_source_event(
        redis, platform="telegram", bot_id="bot-1", group_id="group-1",
        source_event_id="1761746400000-1",
    )
    assert answered["status"] == "ACCEPTED"
    assert answered["accepted_at_ms"] == "1000250"
    assert await lookup_bot_reply(
        redis, platform="telegram", bot_id="bot-1", group_id="another-group",
        platform_message_id="message-a",
    ) is None
    assert await redis.hget(
        "im:attention:ledger:{" + __import__("hashlib").sha256(
            b"telegram\0bot-1\0group-1"
        ).hexdigest() + "}:delivery:delivery-1",
        "status",
    ) == "ACCEPTED"
    await redis.aclose()


@pytest.mark.asyncio
async def test_reply_facts_require_accepted_receipt_and_matching_recipient():
    import fakeredis.aioredis
    from types import SimpleNamespace

    from agent.im.auto_reply.delivery import begin_delivery, settle_delivery
    from agent.im.auto_reply.runtime import _load_bot_reply_facts

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await begin_delivery(
        redis, delivery_id="delivery-2", platform="qq", bot_id="bot-2",
        group_id="group-2", run_key="run-2", source_event_ids=["event-2"],
        recipient_sender_id="member-a", proactive=False, submitted_at_ms=1_000,
    )
    await settle_delivery(
        redis, delivery_id="delivery-2", platform="qq", bot_id="bot-2",
        group_id="group-2", outcome="ACCEPTED", platform_message_id="qq-msg-2",
        accepted_at_ms=1_250,
    )
    messages = [
        SimpleNamespace(reply_to_platform_message_id="qq-msg-2", reply_target_is_bot=True, sender_id="member-a"),
        SimpleNamespace(reply_to_platform_message_id="qq-msg-2", reply_target_is_bot=True, sender_id="member-b"),
        SimpleNamespace(reply_to_platform_message_id="qq-msg-2", reply_target_is_bot=False, sender_id="member-a"),
    ]

    facts = await _load_bot_reply_facts(
        redis, messages, platform="qq", bot_id="bot-2", group_id="group-2",
    )

    assert set(facts) == {"qq-msg-2"}
    assert facts["qq-msg-2"].recipient_sender_id == "member-a"
    assert facts["qq-msg-2"].sent_at_ms == 1_250
    assert facts["qq-msg-2"].accepted is True
    await redis.aclose()


@pytest.mark.asyncio
async def test_accepted_member_active_answer_remains_available_but_tool_message_does_not():
    from agent.im.auto_reply.delivery import accepted_finals_before, member_activation_before

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    common = dict(
        platform="qq", bot_id="bot-3", group_id="group-3", run_key="run-3",
        source_event_ids=["1761746400000-1"], recipient_sender_id="member-a",
        proactive=False, submitted_at_ms=1_000, final_payload_text="synthetic answer",
    )
    await begin_delivery(
        redis, delivery_id="answer-active", source_attention_kind="member_ACTIVE", **common,
    )
    await settle_delivery(
        redis, delivery_id="answer-active", platform="qq", bot_id="bot-3",
        group_id="group-3", outcome="ACCEPTED", platform_message_id="answer-message",
        accepted_at_ms=1_250,
    )
    await begin_delivery(
        redis, delivery_id="tool-progress", source_attention_kind="tool", **common,
    )
    await settle_delivery(
        redis, delivery_id="tool-progress", platform="qq", bot_id="bot-3",
        group_id="group-3", outcome="ACCEPTED", platform_message_id="tool-message",
        accepted_at_ms=1_300,
    )

    accepted = await accepted_finals_before(
        redis, platform="qq", bot_id="bot-3", group_id="group-3", watermark_ms=2_000,
    )

    assert [item["source_attention_kind"] for item in accepted] == ["member_ACTIVE"]
    assert accepted[0]["recipient_sender_id"] == "member-a"
    active_receipt = await member_activation_before(
        redis, platform="qq", bot_id="bot-3", group_id="group-3",
        sender_id="member-a", watermark_ms=1_250,
    )
    assert active_receipt["delivery_id"] == "answer-active"
    assert await member_activation_before(
        redis, platform="qq", bot_id="bot-3", group_id="group-3",
        sender_id="member-a", watermark_ms=1_249,
    ) is None
    assert await member_activation_before(
        redis, platform="qq", bot_id="bot-3", group_id="group-3",
        sender_id="member-b", watermark_ms=2_000,
    ) is None
    await redis.aclose()


def test_shallow_copied_send_payloads_cannot_reuse_delivery_ordinals():
    from agent.im.replies import _next_attention_delivery_ordinal

    original = {
        "_attention_delivery_ordinal": 2,
        "_attention_delivery_counter": {"value": 2},
    }
    response_payload = {**original}

    assert _next_attention_delivery_ordinal(response_payload) == 3
    assert _next_attention_delivery_ordinal(original) == 4
    assert _next_attention_delivery_ordinal(response_payload) == 5


@pytest.mark.asyncio
async def test_tool_send_payload_uses_shared_attention_ledger_without_answer_attribution(monkeypatch):
    import json

    from agent.im import imctx
    from agent.im.replies import send_text
    from agent.im.auto_reply.delivery import (
        _delivery_key, _scope_digest, delivery_id_for,
    )
    from agent.gateway import qq

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    async def accepted_group_send(*_args, **_kwargs):
        return {"accepted": True, "platform_message_id": "tool-message-1"}

    monkeypatch.setattr(qq, "send_group", accepted_group_send)
    receipts = []
    attention_context = {
        "_attention_track_delivery": True,
        "_attention_run_key": "run-tool-1",
        "_attention_delivery_counter": {"value": 0},
        "_attention_decision_kind": "proactive",
        "_attention_outbound_receipts": receipts,
        "_attention_source_event_ids": ["source-event-1"],
    }
    imctx.set_im(
        "qq", "message-1", "bot-1", "group-1", "member-1", "group",
        attention_delivery_context=attention_context,
    )
    payload = imctx.to_send_payload()
    assert payload["_attention_delivery_role"] == "tool"

    assert await send_text(payload, "工具发出的进度消息")
    delivery_id = delivery_id_for("run-tool-1", 1)
    record = await redis.hgetall(_delivery_key(
        _scope_digest("qq", "bot-1", "group-1"), delivery_id,
    ))
    assert json.loads(record["source_event_ids"]) == ["source-event-1"]
    assert json.loads(record["answer_source_event_ids"]) == []
    assert record["status"] == "ACCEPTED"
    assert receipts[0]["status"] == "ACCEPTED"
    assert record["proactive"] == "0"
    imctx.clear()
    await redis.aclose()


def test_platform_failures_preserve_confirmed_and_ambiguous_outcomes():
    from agent.gateway.qq.client import QQAPIError
    from agent.gateway.qq.outbound import _failed_send_receipt

    assert _failed_send_receipt(
        QQAPIError("POST", "/messages", 400, {}), return_receipt=True,
    ) == {"accepted": False, "outcome": "FAILED_CONFIRMED"}
    assert _failed_send_receipt(
        QQAPIError("POST", "/messages", 503, {}), return_receipt=True,
    ) == {"accepted": False, "outcome": "UNKNOWN"}
    assert _failed_send_receipt(
        TimeoutError(), return_receipt=True,
    ) == {"accepted": False, "outcome": "UNKNOWN"}


@pytest.mark.asyncio
async def test_sent_link_button_result_is_recorded_as_accepted_delivery(monkeypatch):
    import fakeredis.aioredis
    from agent.im.replies import _settle_attention_delivery

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    await begin_delivery(
        redis, delivery_id="button-delivery", platform="qq", bot_id="bot-1",
        group_id="group-1", run_key="run-1", source_event_ids=["event-1"],
        recipient_sender_id="member-1", proactive=True, submitted_at_ms=1_000,
    )
    payload = {"_attention_outbound_receipts": []}

    accepted = await _settle_attention_delivery(
        payload,
        {
            "delivery_id": "button-delivery", "platform": "qq",
            "bot_id": "bot-1", "group_id": "group-1",
        },
        {"status": "sent", "delivery": "native"},
    )

    assert accepted is True
    assert payload["_attention_outbound_receipts"] == [{
        "delivery_id": "button-delivery", "status": "ACCEPTED",
        "platform_message_id": None,
    }]
    assert await begin_delivery(
        redis, delivery_id="button-delivery", platform="qq", bot_id="bot-1",
        group_id="group-1", run_key="run-1", source_event_ids=["event-1"],
        recipient_sender_id="member-1", proactive=True, submitted_at_ms=2_000,
    ) == "ACCEPTED"
    await redis.aclose()
