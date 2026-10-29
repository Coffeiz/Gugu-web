"""保护注意力分类优先级、用户模式阈值和批内消息隔离。"""
from agent.im.auto_reply.attention import (
    AttentionMessage,
    AttentionDecision,
    AttentionKind,
    AttentionMode,
    AttentionSnapshot,
    BotReplyFact,
    decide_attention,
)


def message(**overrides):
    values = {
        "event_id": "1761746400000-3",
        "platform": "qq",
        "bot_id": "bot-1",
        "group_id": "group-1",
        "platform_message_id": "m-1",
        "sender_id": "member-1",
        "event_received_ms": 1_761_746_400_000,
        "platform_sent_ms": None,
        "raw_text": "",
        "media_only": False,
        "media_kinds": (),
        "processable_media": None,
        "mentioned_current_bot": False,
        "mentioned_other_bot": False,
        "mentioned_other_member": False,
        "has_unresolved_mention": False,
        "reply_to_platform_message_id": None,
        "reply_target_sender_id": None,
        "reply_target_is_bot": None,
        "quote_text": None,
        "sender_is_bot": False,
    }
    values.update(overrides)
    return AttentionMessage(**values)


def test_explicit_bot_mention_precedes_other_mention_and_hard_reject():
    item = message(
        raw_text="@咕咕 @同事 帮我看看日志报错",
        mentioned_current_bot=True,
        mentioned_other_member=True,
    )
    decision = decide_attention(item, AttentionSnapshot(complete=True), AttentionMode.QUIET)
    assert decision == AttentionDecision(AttentionKind.DIRECT, 100, None, ("DIRECT_invitation",))


def test_explicit_alias_call_is_direct_only_when_it_contains_a_request():
    snapshot = AttentionSnapshot(complete=True)
    assert decide_attention(
        message(raw_text="咕咕，帮我分析一下 Python 配置"), snapshot, AttentionMode.QUIET,
        bot_aliases=("咕咕",),
    ).kind is AttentionKind.DIRECT
    assert decide_attention(
        message(raw_text="咕咕，今天真热"), snapshot, AttentionMode.QUIET,
        bot_aliases=("咕咕",),
    ).kind is AttentionKind.PASSIVE


def test_autonomous_mode_admits_ordinary_messages_without_attention_classification():
    decision = decide_attention(
        message(raw_text="哈哈"),
        AttentionSnapshot(complete=False),
        AttentionMode.AUTONOMOUS,
    )

    assert decision == AttentionDecision(
        AttentionKind.ALLOW_RUN, None, None, ("autonomous_bypass",)
    )


def test_verified_bot_reply_continues_only_for_same_sender_and_recent_accepted_message():
    current = message(
        raw_text="这个配置怎么改？",
        reply_to_platform_message_id="bot-msg",
        reply_target_sender_id="member-1",
        reply_target_is_bot=True,
    )
    snapshot = AttentionSnapshot(
        complete=True,
        bot_replies={"bot-msg": BotReplyFact("bot-msg", current.event_received_ms - 60_000, "member-1", True)},
    )
    assert decide_attention(current, snapshot, AttentionMode.QUIET).kind is AttentionKind.CONTINUE
    wrong_sender = message(
        raw_text=current.raw_text,
        sender_id="member-2",
        reply_to_platform_message_id="bot-msg",
        reply_target_sender_id="member-1",
        reply_target_is_bot=True,
    )
    assert decide_attention(wrong_sender, snapshot, AttentionMode.ACTIVE).kind is AttentionKind.PASSIVE


def test_trusted_processable_media_reply_is_continuation_without_text():
    current = message(
        raw_text="",
        media_only=True,
        media_kinds=("image",),
        processable_media=True,
        reply_to_platform_message_id="bot-msg",
        reply_target_sender_id="member-1",
        reply_target_is_bot=True,
    )
    snapshot = AttentionSnapshot(
        complete=True,
        bot_replies={"bot-msg": BotReplyFact("bot-msg", current.event_received_ms - 60_000, "member-1", True)},
    )
    assert decide_attention(current, snapshot, AttentionMode.QUIET).kind is AttentionKind.CONTINUE
    assert decide_attention(
        current,
        AttentionSnapshot(complete=False, bot_replies=snapshot.bot_replies),
        AttentionMode.ACTIVE,
    ).kind is AttentionKind.PASSIVE


def test_quiet_suppresses_open_candidates_while_natural_and_active_apply_thresholds():
    current = message(raw_text="Python 的连接池超时怎么处理？")
    snapshot = AttentionSnapshot(complete=True, watermark_ms=current.event_received_ms)
    quiet = decide_attention(current, snapshot, AttentionMode.QUIET)
    natural = decide_attention(current, snapshot, AttentionMode.NATURAL)
    active = decide_attention(current, snapshot, AttentionMode.ACTIVE)
    assert quiet.kind is AttentionKind.PASSIVE
    assert quiet.reasons == ("quiet_mode_suppresses_open_candidate",)
    assert natural.kind is AttentionKind.PROACTIVE and natural.threshold == 70 and natural.score == 70
    assert active.kind is AttentionKind.PROACTIVE and active.threshold == 55 and active.score == 70
    assert dict(natural.score_breakdown) == {
        "P02_substantive_question": 30,
        "P03_concrete_context": 15,
        "P05_quiet_conversation": 10,
        "P07_implicit_open_audience": 15,
    }


def test_incomplete_snapshot_never_promotes_an_open_candidate():
    current = message(raw_text="有谁能推荐一下咖啡豆？")
    decision = decide_attention(current, AttentionSnapshot(complete=False), AttentionMode.ACTIVE)
    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons == ("snapshot_incomplete",)


def test_budget_is_required_only_after_proactive_candidate_passes_scoring():
    current = message(raw_text="有谁能推荐一下咖啡豆？")
    recent = message(
        event_id="1761746399000-0",
        event_received_ms=current.event_received_ms - 1000,
        sender_id="member-2",
        raw_text="刚开始学手冲",
    )
    snapshot = AttentionSnapshot(messages=(recent,), complete=True, watermark_ms=current.event_received_ms)
    decision = decide_attention(current, snapshot, AttentionMode.ACTIVE, budget_available=False)
    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons[-1] == "proactive_budget_unavailable"


def test_each_message_is_classified_independently_instead_of_batch_splicing():
    open_question = message(raw_text="有谁能推荐一下咖啡豆？", sender_id="member-1")
    short_reaction = message(raw_text="哈哈", sender_id="member-2")
    snapshot = AttentionSnapshot(complete=True)
    assert decide_attention(open_question, snapshot, AttentionMode.ACTIVE).kind is AttentionKind.PROACTIVE
    assert decide_attention(short_reaction, snapshot, AttentionMode.ACTIVE).kind is AttentionKind.PASSIVE
