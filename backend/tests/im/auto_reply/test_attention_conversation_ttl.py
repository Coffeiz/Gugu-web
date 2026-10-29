"""成员级会话续接窗口的准入与出站确认回归。"""
import fakeredis.aioredis
import pytest

from agent.im.auto_reply.attention import (
    AttentionKind,
    AttentionMessage,
    AttentionMode,
    AttentionSnapshot,
    decide_attention,
)
from agent.im.auto_reply.conversation_ttl import (
    CONVERSATION_TTL_SECONDS,
    has_active_conversation,
    record_accepted_reply,
    record_conversation_after_final_reply,
)


def _message(event_id: str, **overrides) -> AttentionMessage:
    payload = {
        "platform": "qq",
        "channel_id": "bot-1",
        "chat_id": "group-1",
        "platform_user_id": "member-1",
        "sender_is_bot": False,
        "native_bot_mentioned": False,
        "text": "为什么？",
        **overrides,
    }
    return AttentionMessage.from_payload(event_id, payload)


def test_active_conversation_allows_short_followup_without_scoring_or_budget():
    decision = decide_attention(
        _message("1761746400000-1"),
        AttentionSnapshot(complete=False),
        AttentionMode.QUIET,
        budget_available=False,
        conversation_active=True,
    )

    assert decision.kind is AttentionKind.CONTINUE
    assert decision.reasons == ("CONVERSATION_CONTINUE_ttl",)
    assert decision.score == 100
    assert decision.threshold is None


@pytest.mark.parametrize(
    ("text", "extra", "reason"),
    [
        ("已解决，谢谢", {}, "CONVERSATION_END_explicit"),
        ("咕咕，已解决了", {"native_bot_mentioned": True}, "CONVERSATION_END_explicit"),
        ("@月月 你看看", {"mentions_other_bot": True}, "CONVERSATION_REDIRECT_other_mention"),
        ("转给同事处理", {"has_unresolved_mention": True}, "CONVERSATION_REDIRECT_unresolved_mention"),
    ],
)
def test_explicit_end_or_redirect_closes_instead_of_continuing(text, extra, reason):
    message = _message("1761746400000-1", text=text, **extra)

    decision = decide_attention(
        message,
        AttentionSnapshot(complete=False),
        AttentionMode.ACTIVE,
        conversation_active=True,
    )

    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons == (reason,)


@pytest.mark.asyncio
async def test_ttl_is_scoped_to_member_and_expires_from_accepted_reply_time():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    accepted_at_ms = 1_000_000
    assert await record_accepted_reply(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        run_key="run-1",
        source_event_id="source-1",
        accepted_at_ms=accepted_at_ms,
    )
    # 同一 Run 的重复结算不能延长窗口。
    assert not await record_accepted_reply(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        run_key="run-1",
        source_event_id="source-1",
        accepted_at_ms=accepted_at_ms + 60_000,
    )

    async def active(sender_id, received_at_ms):
        return await has_active_conversation(
            redis,
            platform="qq",
            bot_id="bot-1",
            group_id="group-1",
            sender_id=sender_id,
            event_received_ms=received_at_ms,
        )

    assert await active("member-1", accepted_at_ms + 1)
    assert await active("member-1", accepted_at_ms + CONVERSATION_TTL_SECONDS * 1000)
    assert not await active("member-1", accepted_at_ms + CONVERSATION_TTL_SECONDS * 1000 + 1)
    assert not await active("member-2", accepted_at_ms + 1)
    await redis.aclose()


@pytest.mark.asyncio
async def test_explicit_end_deletes_the_member_window():
    from agent.im.auto_reply import runtime

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    accepted_at_ms = 1_761_746_400_000
    await record_accepted_reply(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        run_key="run-1",
        source_event_id="source-1",
        accepted_at_ms=accepted_at_ms,
    )
    message = _message(
        f"{accepted_at_ms + 1}-1",
        text="先这样，已经解决了",
    )

    decision, _anchor = await runtime._decide_attention_message(
        redis,
        message,
        AttentionSnapshot(complete=False),
        AttentionMode.ACTIVE,
        bot_aliases=(),
    )

    assert decision.kind is AttentionKind.PASSIVE
    assert not await has_active_conversation(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        event_received_ms=accepted_at_ms + 2,
    )
    await redis.aclose()


@pytest.mark.asyncio
async def test_only_accepted_final_answer_opens_conversation(monkeypatch):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    payload = {
        "chat_type": "group",
        "platform": "qq",
        "channel_id": "bot-1",
        "chat_id": "group-1",
        "_attention_conversation_subject_sender_id": "member-1",
        "_attention_source_event_ids": ["source-1"],
        "_attention_outbound_receipts": [
            {"role": "tool", "status": "ACCEPTED", "accepted_at_ms": 5_000},
        ],
    }

    assert not await record_conversation_after_final_reply(payload, run_key="run-1")
    payload["_attention_outbound_receipts"].append({
        "role": "answer", "status": "UNKNOWN", "accepted_at_ms": 5_000,
    })
    assert not await record_conversation_after_final_reply(payload, run_key="run-1")
    payload["_attention_outbound_receipts"].append({
        "role": "answer", "status": "ACCEPTED", "accepted_at_ms": 5_000,
    })

    assert await record_conversation_after_final_reply(payload, run_key="run-1")
    assert await has_active_conversation(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        event_received_ms=5_001,
    )
    await redis.aclose()


@pytest.mark.asyncio
async def test_reply_mentions_preflight_requires_active_window_and_is_read_only_safe(monkeypatch):
    from agent.im.auto_reply.runtime import preflight_active_conversation_event_ids

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    payload = {
        "platform": "qq",
        "channel_id": "bot-1",
        "chat_id": "group-1",
        "chat_type": "group",
        "group_requires_at": True,
        "group_read_enabled": False,
        "event_id": "1761746400001-1",
        "platform_user_id": "member-1",
        "sender_is_bot": False,
        "native_bot_mentioned": False,
        "text": "然后呢？",
    }
    assert await preflight_active_conversation_event_ids(payload) == []
    await record_accepted_reply(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        run_key="run-1",
        source_event_id="source-1",
        accepted_at_ms=1_761_746_400_000,
    )

    assert await preflight_active_conversation_event_ids(payload) == ["1761746400001-1"]
    payload["group_read_enabled"] = True
    assert await preflight_active_conversation_event_ids(payload) == []
    await redis.aclose()


@pytest.mark.asyncio
async def test_reply_mentions_continuation_runs_without_loading_scoring_snapshot(monkeypatch):
    from types import SimpleNamespace

    from agent.im.auto_reply import runtime
    from agent.im.auto_reply.attention import AttentionKind

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)

    async def unexpected_snapshot(*_args, **_kwargs):
        raise AssertionError("TTL-only continuation must not load scoring history")

    monkeypatch.setattr(runtime, "load_attention_snapshot", unexpected_snapshot)
    event_id = "1761746400001-1"
    await record_accepted_reply(
        redis,
        platform="qq",
        bot_id="bot-1",
        group_id="group-1",
        sender_id="member-1",
        run_key="run-1",
        source_event_id="source-1",
        accepted_at_ms=1_761_746_400_000,
    )
    payload = {
        "platform": "qq",
        "channel_id": "bot-1",
        "chat_id": "group-1",
        "chat_type": "group",
        "group_attention_mode": "natural",
        "_attention_continuation_only": True,
        "_attention_active_conversation_event_ids": [event_id],
        "event_id": event_id,
        "platform_user_id": "member-1",
        "sender_is_bot": False,
        "native_bot_mentioned": False,
        "text": "为什么？",
    }

    should_run, decision, reservation = await runtime.evaluate_group_attention(
        SimpleNamespace(session_id=None), payload,
    )

    assert should_run is True
    assert decision.kind is AttentionKind.CONTINUE
    assert reservation is None
    assert payload["_attention_conversation_subject_sender_id"] == "member-1"
    assert payload["_attention_source_event_ids"] == [event_id]
    await redis.aclose()


def test_direct_group_invitation_delivery_is_attributed_to_mentioning_member():
    from types import SimpleNamespace

    from agent.im.dispatch import _track_direct_group_invitation

    event_id = "1761746400001-1"
    payload = {
        "platform": "qq",
        "channel_id": "bot-1",
        "chat_id": "group-1",
        "chat_type": "group",
        "group_mentioned": True,
        "group_read_enabled": False,
        "_batch_messages": [{
            "event_id": event_id,
            "platform_user_id": "inviter-1",
            "sender_is_bot": False,
            "native_bot_mentioned": True,
            "text": "帮我看看",
        }],
    }

    _track_direct_group_invitation(payload, SimpleNamespace(inbound_batch_key="run-1"))

    assert payload["_attention_track_delivery"] is True
    assert payload["_attention_run_key"] == "run-1"
    assert payload["_attention_conversation_subject_sender_id"] == "inviter-1"
    assert payload["_attention_source_event_ids"] == [event_id]
