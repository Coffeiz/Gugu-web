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
        budget_kind="proactive",
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
    from agent.im.auto_reply.runtime import _load_answered_question_facts

    from agent.im.auto_reply.delivery import begin_delivery, settle_delivery
    from agent.im.auto_reply.runtime import _load_bot_reply_facts

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await begin_delivery(
        redis, delivery_id="delivery-2", platform="qq", bot_id="bot-2",
        group_id="group-2", run_key="run-2", source_event_ids=["event-2"],
        recipient_sender_id="member-a", budget_kind=None, submitted_at_ms=1_000,
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
async def test_accepted_answer_is_mapped_back_to_source_question_for_n07():
    from types import SimpleNamespace
    from agent.im.auto_reply.runtime import _load_answered_question_facts

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await begin_delivery(
        redis, delivery_id="answer-delivery", platform="qq", bot_id="bot-3",
        group_id="group-3", run_key="answer-run", source_event_ids=["source-1"],
        answer_source_event_ids=["source-1"], recipient_sender_id="member-3",
        budget_kind="proactive", submitted_at_ms=10_000,
    )
    await settle_delivery(
        redis, delivery_id="answer-delivery", platform="qq", bot_id="bot-3",
        group_id="group-3", outcome="ACCEPTED", platform_message_id="answer-1",
        answer_source_event_ids=["source-1"], accepted_at_ms=10_500,
    )
    source = SimpleNamespace(
        event_id="source-1", sender_is_bot=False, event_received_ms=10_000,
        platform_message_id="question-1", raw_text="Python 连接池超时怎么排查？",
    )

    question_ids, question_texts = await _load_answered_question_facts(
        redis, [source], platform="qq", bot_id="bot-3", group_id="group-3", now_ms=11_000,
    )

    assert question_ids == {"question-1"}
    assert question_texts == {"python连接池超时怎么排查"}
    await redis.aclose()


@pytest.mark.asyncio
async def test_sent_link_button_result_is_recorded_as_accepted_delivery(monkeypatch):
    import fakeredis.aioredis
    from agent.im.replies import _settle_attention_delivery

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    await begin_delivery(
        redis, delivery_id="button-delivery", platform="qq", bot_id="bot-1",
        group_id="group-1", run_key="run-1", source_event_ids=["event-1"],
        recipient_sender_id="member-1", budget_kind="proactive", submitted_at_ms=1_000,
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
        recipient_sender_id="member-1", budget_kind="proactive", submitted_at_ms=2_000,
    ) == "ACCEPTED"
    await redis.aclose()
