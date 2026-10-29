"""对照 PRD-IM-17 v1.4 场景计算表验证确定性注意力规则。"""
from dataclasses import replace

import pytest

from agent.im.auto_reply.attention import (
    AttentionKind,
    AttentionMessage,
    AttentionMode,
    AttentionSnapshot,
    BotReplyFact,
    build_logical_candidates,
    decide_attention,
    score_open_candidate,
)


def msg(text, *, event_id="1761746400000-0", sender="member-a", **overrides):
    data = {
        "event_id": event_id,
        "platform": "qq",
        "bot_id": "bot-a",
        "group_id": "group-a",
        "platform_message_id": f"platform-{event_id}",
        "sender_id": sender,
        "event_received_ms": int(event_id.split("-", 1)[0]),
        "platform_sent_ms": None,
        "raw_text": text,
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
    data.update(overrides)
    return AttentionMessage(**data)


def quiet_snapshot(*, watermark=None, **kwargs):
    return AttentionSnapshot(
        complete=True,
        watermark_ms=watermark or 1_761_746_400_000,
        **kwargs,
    )


@pytest.mark.parametrize(
    ("text", "expected", "reasons"),
    [
        ("各位，推荐一款适合剪辑的 32G 内存笔记本？", 90,
         {"P01_group_broadcast_request", "P02_substantive_question", "P03_concrete_context", "P05_quiet_conversation"}),
        ("有人知道 FastAPI 连接池报错怎么解决吗？", 90,
         {"P01_group_broadcast_request", "P02_substantive_question", "P03_concrete_context", "P05_quiet_conversation"}),
        ("有人知道这个文档在哪里吗？", 75,
         {"P01_group_broadcast_request", "P02_substantive_question", "P05_quiet_conversation"}),
        ("Python 的连接池超时怎么处理？", 70,
         {"P02_substantive_question", "P03_concrete_context", "P05_quiet_conversation", "P07_implicit_open_audience"}),
    ],
)
def test_open_invite_candidates_follow_prd_weight_calculation(text, expected, reasons):
    score, actual_reasons = score_open_candidate(msg(text), quiet_snapshot())
    assert score == expected
    assert set(actual_reasons) == reasons


def test_score_does_not_increase_just_because_time_passes_without_a_reply():
    current = msg("Python 的连接池超时怎么处理？")
    before = score_open_candidate(
        current,
        quiet_snapshot(watermark=current.event_received_ms + 4_999),
    )
    after = score_open_candidate(
        current,
        quiet_snapshot(watermark=current.event_received_ms + 5_000),
    )
    later = msg(
        "我不知道",
        event_id=f"{current.event_received_ms + 1}-0",
        sender="member-b",
    )
    answered = score_open_candidate(
        current,
        quiet_snapshot(
            watermark=current.event_received_ms + 5_000,
            messages=(later,),
        ),
    )

    assert before[0] == after[0] == answered[0]
    assert all("P04_unanswered_observed" not in reasons for _, reasons in (before, after, answered))


def test_direct_and_verified_followup_scenarios_bypass_scoring_but_thanks_does_not():
    current_call = msg("咕咕，你觉得这个方案呢？")
    assert decide_attention(
        current_call, quiet_snapshot(), AttentionMode.NATURAL,
        bot_aliases=("咕咕",), budget_available=False,
    ).kind is AttentionKind.DIRECT

    followup = msg(
        "这个错误还是没解决",
        reply_to_platform_message_id="bot-reply-1",
        reply_target_sender_id="member-a",
        reply_target_is_bot=True,
    )
    snapshot = quiet_snapshot(bot_replies={
        "bot-reply-1": BotReplyFact(
            "bot-reply-1", followup.event_received_ms - 30_000, "member-a", True,
        ),
    })
    assert decide_attention(followup, snapshot, AttentionMode.QUIET).kind is AttentionKind.CONTINUE
    thanks = replace(followup, raw_text="谢谢")
    assert decide_attention(thanks, snapshot, AttentionMode.ACTIVE).kind is AttentionKind.PASSIVE


@pytest.mark.parametrize(
    ("candidate", "expected_reason"),
    [
        (msg("哈哈哈"), "H02_short_reaction"),
        (msg("@其他Bot 看下这个", mentioned_other_bot=True), "H03_other_mention"),
        (msg("你这个建议怎么理解？", reply_to_platform_message_id="human-1", reply_target_is_bot=False), "H04_reply_to_other"),
        (msg("这也行？"), "H06_social_expression"),
    ],
)
def test_hard_reject_rules_match_scored_modes(candidate, expected_reason):
    decision = decide_attention(candidate, quiet_snapshot(), AttentionMode.ACTIVE)
    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons == (expected_reason,)


def test_h08_requires_verified_resolution_by_question_owner():
    question = "question-7"
    current = msg(
        "已经解决了",
        reply_to_platform_message_id=question,
        reply_target_sender_id="member-a",
        reply_target_is_bot=False,
    )
    snapshot = quiet_snapshot(
        resolved_question_ids=frozenset({question}),
        question_owners={question: "member-a"},
    )
    assert decide_attention(current, snapshot, AttentionMode.ACTIVE).reasons == ("H08_question_resolved",)
    other = replace(current, sender_id="member-b")
    assert "H08_question_resolved" not in decide_attention(
        other, snapshot, AttentionMode.ACTIVE,
    ).reasons


def test_peer_exchange_and_busy_group_recalculate_all_features_without_p05():
    now = 1_761_746_400_000
    history = [
        msg("旧消息", event_id=f"{now - 7_000 + index * 1_000}-0",
            sender=f"member-{index}", platform_message_id=f"m-{index}")
        for index in range(7)
    ]
    history[-2] = replace(history[-2], sender_id="member-a", platform_message_id="m-a",
                          reply_to_platform_message_id=None)
    history[-1] = replace(history[-1], sender_id="member-b", platform_message_id="m-b",
                          reply_to_platform_message_id="m-a", reply_target_sender_id="member-a")
    candidate = msg(
        "有人知道 FastAPI 连接池报错怎么办吗？",
        event_id=f"{now}-0", sender="member-a",
        platform_message_id="m-c", reply_to_platform_message_id="m-b",
        reply_target_sender_id="member-b",
    )
    score, reasons = score_open_candidate(
        candidate,
        quiet_snapshot(messages=tuple(history)),
    )
    assert score == 25
    assert "N01_strong_peer_exchange" in reasons
    assert "N02_weak_peer_exchange" not in reasons
    assert "N05_busy_group" in reasons
    assert "P05_quiet_conversation" not in reasons


def test_strong_and_weak_peer_exchange_features_are_mutually_exclusive():
    now = 1_761_746_400_000
    a = msg("先前讨论", event_id=f"{now - 2_000}-0", sender="member-a", platform_message_id="a-1")
    b = msg(
        "接着讨论", event_id=f"{now - 1_000}-0", sender="member-b", platform_message_id="b-1",
        reply_to_platform_message_id="a-1", reply_target_sender_id="member-a",
    )
    current = msg(
        "有人知道 FastAPI 连接池报错怎么办吗？", event_id=f"{now}-0", sender="member-a",
        platform_message_id="a-2",
    )
    weak_score, weak_reasons = score_open_candidate(
        current, quiet_snapshot(messages=(replace(a, reply_to_platform_message_id=None), replace(b, reply_to_platform_message_id=None))),
    )
    strong = replace(
        current, reply_to_platform_message_id="b-1", reply_target_sender_id="member-b",
        reply_target_is_bot=False,
    )
    strong_score, strong_reasons = score_open_candidate(strong, quiet_snapshot(messages=(a, b)))

    assert weak_score == 60 and "N02_weak_peer_exchange" in weak_reasons
    assert "N01_strong_peer_exchange" not in weak_reasons
    assert strong_score == 35 and "N01_strong_peer_exchange" in strong_reasons
    assert "N02_weak_peer_exchange" not in strong_reasons


def test_recent_proactive_reply_reduces_score_only_after_acceptance():
    candidate = msg("有人知道 FastAPI 连接池报错怎么解决吗？")
    reply = BotReplyFact("bot-1", candidate.event_received_ms - 120_000, "member-a", True, proactive=True)
    score, reasons = score_open_candidate(candidate, quiet_snapshot(bot_replies={"bot-1": reply}))
    assert score == 65
    assert "N04_recent_proactive_bot_reply" in reasons


def test_resolved_and_previously_answered_questions_apply_distinct_rules():
    question_id = "question-1"
    resolved = msg(
        "已经解决了", reply_to_platform_message_id=question_id,
        reply_target_sender_id="member-a", reply_target_is_bot=False,
    )
    snapshot = quiet_snapshot(
        resolved_question_ids=frozenset({question_id}),
        question_owners={question_id: "member-a"},
    )
    assert decide_attention(resolved, snapshot, AttentionMode.ACTIVE).reasons == ("H08_question_resolved",)

    answered = msg("有人知道 FastAPI 连接池报错怎么解决吗？", platform_message_id="question-2")
    score, reasons = score_open_candidate(
        answered,
        quiet_snapshot(answered_question_ids=frozenset({"question-2"})),
    )
    assert score == 50 and "N07_bot_already_answered" in reasons


def test_other_bot_mention_and_unanchored_recent_reply_do_not_create_continuation():
    other_bot = msg(
        "@咕咕 帮我看看", mentioned_current_bot=False, mentioned_other_bot=True,
        has_unresolved_mention=False,
    )
    assert decide_attention(other_bot, quiet_snapshot(), AttentionMode.ACTIVE).reasons == ("H03_other_mention",)

    new_topic = msg("Python 的连接池超时怎么处理？")
    recent_bot_reply = BotReplyFact("bot-1", new_topic.event_received_ms - 20_000, "member-a", True)
    decision = decide_attention(
        new_topic,
        quiet_snapshot(bot_replies={"bot-1": recent_bot_reply}),
        AttentionMode.NATURAL,
    )
    assert decision.kind is AttentionKind.PROACTIVE
    assert decision.reasons[0] != "CONTINUE_verified_reply"


@pytest.mark.parametrize(
    ("kind", "processable", "target_is_bot", "recipient", "age_ms", "expected"),
    [
        ("image", True, True, "member-a", 60_000, AttentionKind.CONTINUE),
        ("image", True, True, None, 60_000, AttentionKind.PASSIVE),
        ("image", True, True, "member-a", 120_001, AttentionKind.PASSIVE),
        ("sticker", True, True, "member-a", 60_000, AttentionKind.PASSIVE),
        ("image", None, True, "member-a", 60_000, AttentionKind.PASSIVE),
        ("image", True, False, "member-a", 60_000, AttentionKind.PASSIVE),
    ],
)
def test_media_continuation_requires_all_verified_facts(
    kind, processable, target_is_bot, recipient, age_ms, expected,
):
    now = 1_761_746_400_000
    current = msg(
        "", media_only=True, media_kinds=(kind,), processable_media=processable,
        reply_to_platform_message_id="bot-reply", reply_target_sender_id=recipient,
        reply_target_is_bot=target_is_bot,
    )
    snapshot = quiet_snapshot(bot_replies={
        "bot-reply": BotReplyFact("bot-reply", now - age_ms, recipient, True),
    })
    assert decide_attention(current, snapshot, AttentionMode.QUIET).kind is expected


def test_scenario_36_text_claim_without_processable_media_is_not_media_continuation():
    candidate = msg("这是截图")
    decision = decide_attention(candidate, quiet_snapshot(), AttentionMode.ACTIVE)
    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons == ("not_open_candidate",)


@pytest.mark.parametrize("mode", [AttentionMode.NATURAL, AttentionMode.ACTIVE])
def test_scenario_14_unscored_media_fallback_requires_processable_media_and_explicit_review(mode):
    candidate = msg(
        "请看看这个", media_only=False, media_kinds=("image",),
        processable_media=True,
    )
    decision = decide_attention(candidate, quiet_snapshot(), mode)
    assert decision.kind is AttentionKind.PROACTIVE
    assert decision.score is None and decision.threshold is None
    assert decision.reasons == ("UNSCORED_FALLBACK_processable_media_with_explicit_request",)

    unresolved = msg("", media_only=True, media_kinds=("file",), processable_media=True)
    assert decide_attention(unresolved, quiet_snapshot(), mode).reasons == ("media_unresolved",)
    unprocessable = replace(candidate, processable_media=None)
    assert decide_attention(unprocessable, quiet_snapshot(), mode).reasons == ("media_unresolved",)


def test_unscored_media_fallback_uses_proactive_budget_and_respects_hard_routing():
    candidate = msg(
        "请看看这个", media_kinds=("image",), processable_media=True,
    )
    blocked = decide_attention(
        candidate, quiet_snapshot(), AttentionMode.NATURAL, budget_available=False,
    )
    assert blocked.kind is AttentionKind.PASSIVE
    assert blocked.reasons == ("UNSCORED_FALLBACK_material_budget_unavailable",)

    other_member = replace(candidate, mentioned_other_member=True)
    assert decide_attention(other_member, quiet_snapshot(), AttentionMode.ACTIVE).reasons == (
        "H03_other_mention",
    )


def test_all_available_score_reasons_clip_to_zero_and_one_hundred():
    now = 1_761_746_400_000
    candidate = msg(
        "各位，有人知道 FastAPI 连接池报错怎么解决吗？",
        platform_message_id="q-1",
        candidate_text="各位，有人知道 FastAPI 连接池报错怎么解决吗？",
    )
    duplicate = msg(
        candidate.raw_text, event_id=f"{now - 1}-0", sender="member-b",
        platform_message_id="q-2",
    )
    high, reasons = score_open_candidate(
        candidate,
        quiet_snapshot(
            watermark=now + 5_000,
            batch_messages=(duplicate,),
        ),
    )
    assert high == 100
    assert {"P05_quiet_conversation", "P06_multiple_independent_askers"} <= set(reasons)
    assert "P04_unanswered_observed" not in reasons

    negative_snapshot = quiet_snapshot(
        answered_question_ids=frozenset({"q-1"}),
        resolved_question_ids=frozenset({"q-1"}),
        question_owners={"q-1": "member-a"},
        bot_replies={"reply": BotReplyFact("reply", now - 1, "member-a", True, proactive=True)},
        messages=tuple(
            msg("chat", event_id=f"{now - 8_000 + i * 1_000}-0", sender=f"person-{i}",
                platform_message_id=f"m-{i}")
            for i in range(8)
        ),
    )
    low, low_reasons = score_open_candidate(
        replace(candidate, reply_to_platform_message_id="q-1"), negative_snapshot,
    )
    assert low == 0
    assert "N04_recent_proactive_bot_reply" in low_reasons
    assert "N05_busy_group" in low_reasons
    assert "N07_bot_already_answered" in low_reasons
    assert "N03_human_answer_confirmed" in low_reasons


def test_unknown_or_unresolved_mention_never_gains_proactive_open_candidate_score():
    candidate = msg(
        "@somebody 有人知道 FastAPI 连接池报错怎么解决吗？",
        has_unresolved_mention=True,
    )
    decision = decide_attention(candidate, quiet_snapshot(), AttentionMode.ACTIVE)
    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons == ("not_open_candidate",)


def test_logical_candidate_deduplicates_event_ids_and_never_combines_across_scope():
    first = msg("FastAPI 报错", event_id="1761746400000-0", sender="member-a")
    repeated = replace(first, raw_text="重复投递内容")
    other_group = msg(
        "连接池超时", event_id="1761746407000-0", sender="member-a", group_id="group-b",
    )
    logical = build_logical_candidates((first, repeated, other_group))
    assert len(logical) == 2
    assert logical[0].candidate_text == "FastAPI 报错"
    assert logical[1].candidate_text == "连接池超时"


def test_n04_only_counts_successfully_accepted_proactive_bot_replies():
    candidate = msg("有人知道 FastAPI 连接池报错怎么解决吗？")
    non_proactive = BotReplyFact("bot-1", candidate.event_received_ms - 120_000, "member-a", True)
    proactive = replace(non_proactive, proactive=True)
    base, _ = score_open_candidate(candidate, quiet_snapshot())
    normal, normal_reasons = score_open_candidate(
        candidate, quiet_snapshot(bot_replies={"bot-1": non_proactive}),
    )
    cooled, cooled_reasons = score_open_candidate(
        candidate, quiet_snapshot(bot_replies={"bot-1": proactive}),
    )
    assert normal == base and "N04_recent_proactive_bot_reply" not in normal_reasons
    assert cooled == base - 25 and "N04_recent_proactive_bot_reply" in cooled_reasons


def test_same_sender_supplements_can_form_candidate_but_never_cross_senders_or_eight_seconds():
    first = msg("FastAPI 报错", event_id="1761746400000-0", sender="member-a")
    supplement = msg("连接池超时", event_id="1761746407000-0", sender="member-a")
    other = msg("Python 怎么设置？", event_id="1761746408000-0", sender="member-b")
    late = msg("版本 3.12", event_id="1761746416001-0", sender="member-a")
    logical = build_logical_candidates((first, supplement, other, late))

    assert logical[0].candidate_text == "FastAPI 报错\n连接池超时"
    assert logical[1].candidate_text == logical[0].candidate_text
    assert logical[2].candidate_text == "Python 怎么设置？"
    assert logical[3].candidate_text == "版本 3.12"
    assert logical[0].raw_text == "FastAPI 报错"


def test_passive_open_candidate_never_scores_into_run_when_snapshot_is_unknown():
    decision = decide_attention(
        msg("有人知道 FastAPI 连接池报错怎么解决吗？"),
        AttentionSnapshot(complete=False),
        AttentionMode.ACTIVE,
    )
    assert decision.kind is AttentionKind.PASSIVE
    assert decision.reasons == ("snapshot_incomplete",)
