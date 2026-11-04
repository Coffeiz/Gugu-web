"""IM-17 v3.0.6 情景评分、局部话题、能力准入及硬路由契约。"""
from dataclasses import replace

import pytest

from agent.im.auto_reply.attention import (
    AttentionKind, AttentionMessage, AttentionMode, AttentionSnapshot, BotReplyFact,
    decide_attention, score_attention,
)
from agent.im.auto_reply import attention_algorithm as algorithm

NOW = 1_761_746_400_000


def message(text: str, *, at_ms: int = NOW, **changes) -> AttentionMessage:
    values = {
        "event_id": f"{at_ms}-0", "platform": "qq", "channel_id": "bot-a",
        "chat_id": "group-a", "platform_user_id": "member-a", "sender_is_bot": False,
        "text": text, "native_bot_mentioned": False, "mentions_other_bot": False,
        "mentions_other_member": False,
    }
    values.update(changes)
    return AttentionMessage.from_payload(str(values.pop("event_id")), values)


def topic_snapshot(text: str, *, age_s: float = 0, context: tuple[AttentionMessage, ...] = ()) -> AttentionSnapshot:
    anchor = BotReplyFact(
        "reply-anchor", NOW - int(age_s * 1000), None, True,
        source_attention_kind="proactive", final_text=text, delivery_id="delivery-anchor",
    )
    return AttentionSnapshot(
        messages=context, complete=True,
        latest_accepted_final=anchor, accepted_outbound_facts=(anchor,),
    )


def test_action_roots_remain_generic_and_complete():
    assert len(algorithm._ACTION_ROOTS) == 95
    assert "看看这个" not in algorithm._ACTION_ROOTS
    assert "怎么处理" not in algorithm._ACTION_ROOTS


def test_positive_language_lexicons_use_single_character_roots():
    lexicons = (
        algorithm._ACTION_ROOTS,
        algorithm._QUESTION_MORPHEMES,
        algorithm._REPORTING_ROOTS,
        algorithm._PERSON_REFERENCE_CHARS,
        algorithm._REFERENCE_CHARS,
        algorithm._GRAMMAR_CHARS,
    )

    assert all(all(len(root) == 1 for root in lexicon) for lexicon in lexicons)


@pytest.mark.parametrize(("text", "expected"), [
    ("咕咕看吧", 92),
    ("咕咕看看这个", 92),
    ("咕咕帮我看看这个算法怎么样", 92),
    ("咕咕别走", 92),
    ("咕咕查这个", 82.8),
    ("咕咕看", 73.6),
    ("咕咕看起来很累", 0),
    ("咕咕走了", 0),
    ("咕咕和小北真的能唠", 0),
    ("我看咕咕今天没说话", 0),
])
def test_call_uses_addressee_predicate_and_imperative_structure(text, expected):
    score, _kind, _uncertain = algorithm._scene_score(message(text), ("咕咕",))
    assert score == pytest.approx(expected / 100)


@pytest.mark.parametrize(("text", "expected"), [
    ("为什么汉密尔顿的音乐这么好听", .90),
    ("为什么汉密尔顿的音乐这么好听啊？", .90),
    ("这个算法怎么样", .90),
    ("Redis 超时怎么解决", .90),
    ("怎么这样啊？", .765),
    ("怎么这样？", .765),
    ("这咋回事", .765),
    ("这咋回事啊", .765),
    ("那怎么回事？", .765),
    ("咋回事", .765),
    ("为什么呢", .765),
    ("你呢", .765),
    ("真的？", .765),
    ("确实？", .765),
    ("离谱？", .765),
    ("他哪会翻跟斗", 0),
    ("这首歌真好听啊", 0),
    ("我不知道为什么会这样", 0),
    ("他说为什么会这样", 0),
    ("他说这咋回事", 0),
    ("？", 0),
])
def test_ask_requires_top_level_question_behavior(text, expected):
    score, _kind, _uncertain = algorithm._scene_score(message(text), ("咕咕",))
    assert score == pytest.approx(expected)


def test_weak_ask_in_long_text_is_position_weighted_but_short_ask_is_unchanged():
    short = algorithm._scene_score_details(message("这个项目为什么延期？"), ("咕咕",))
    assert short[0] == pytest.approx(.90)
    assert short[4] == pytest.approx(1.0)
    assert short[5] == pytest.approx(1.0)
    assert short[6] == pytest.approx(.90)

    long_text = "背景资料" * 450 + "。这个项目为什么延期？。" + "补充材料" * 450
    decision = score_attention(message(long_text), AttentionSnapshot())
    assert decision.scene_type == "ASK"
    assert decision.ask_raw_score == pytest.approx(.90)
    assert decision.ask_position_weight == pytest.approx(.55, abs=.01)
    assert decision.ask_adjusted_score == pytest.approx(.495, abs=.01)
    assert decision.scene_score == pytest.approx(.495, abs=.01)
    assert decision.score == pytest.approx(49.5, abs=1)
    assert decision.ask_span_start is not None
    assert decision.ask_span_end > decision.ask_span_start


def test_long_text_edge_questions_keep_weight_and_max_uses_best_adjusted_evidence():
    text = "项目为什么延期？" + "背景资料" * 200 + "。这个项目为什么延期？。" + "补充材料" * 200 + "。项目如何上线？"
    details = algorithm._scene_score_details(message(text), ("咕咕",))
    assert details[0] == pytest.approx(.90, abs=.01)
    assert details[4] > .90
    assert details[5] == pytest.approx(1.0)
    assert details[6] > .80
    assert details[7] is not None
    assert details[7] < 40 or details[7] > len(text) - 40


def test_explicit_bot_addressed_question_in_long_text_is_not_position_downgraded():
    text = "背景资料" * 300 + "。咕咕，我想问这个项目为什么延期？。" + "补充材料" * 300
    details = algorithm._scene_score_details(message(text), ("咕咕",))
    assert details[3] == pytest.approx(.90)
    assert details[4] == pytest.approx(1.0)
    assert details[5] == pytest.approx(1.0)
    assert details[6] == pytest.approx(.90)


@pytest.mark.parametrize(("text", "punctuation_weight", "expected"), [
    ("为什么延期？", 1.0, .90),
    ("为什么延期", 1.0, .90),
    ("为什么延期。", .65, .585),
    ("请问为什么延期。", 1.0, .90),
    ("我想问为什么延期。", 1.0, .90),
])
def test_ask_terminal_full_stop_downgrades_only_weak_question_evidence(text, punctuation_weight, expected):
    decision = score_attention(message(text), AttentionSnapshot())
    assert decision.scene_type == "ASK"
    assert decision.ask_punctuation_weight == pytest.approx(punctuation_weight)
    assert decision.ask_adjusted_score == pytest.approx(expected)
    assert decision.score == pytest.approx(expected * 100)


def test_question_mark_on_ask_clause_survives_later_full_stop():
    decision = score_attention(
        message("为什么延期？我觉得主要是资源问题。"), AttentionSnapshot(),
    )
    assert decision.ask_punctuation_weight == pytest.approx(1.0)
    assert decision.ask_adjusted_score == pytest.approx(.90)
    assert decision.ask_span_start == 0


def test_full_stop_and_middle_position_weights_multiply_for_weak_ask():
    text = "背景资料" * 450 + "。为什么延期。" + "补充材料" * 450
    decision = score_attention(message(text), AttentionSnapshot())
    assert decision.ask_position_weight == pytest.approx(.55, abs=.01)
    assert decision.ask_punctuation_weight == pytest.approx(.65)
    assert decision.ask_adjusted_score == pytest.approx(.32175, abs=.01)
    assert decision.score == pytest.approx(32.175, abs=1)


def test_terminal_full_stop_question_crosses_active_but_not_natural_threshold():
    current = message("为什么延期。")
    assert decide_attention(current, AttentionSnapshot(), AttentionMode.NATURAL).kind is AttentionKind.PASSIVE
    active = decide_attention(current, AttentionSnapshot(), AttentionMode.ACTIVE)
    assert active.kind is AttentionKind.PROACTIVE
    assert active.score == pytest.approx(58.5)


def test_scene_ignores_quoted_code_and_long_material():
    request = "咕咕帮我看看"
    long_code = "\n```python\n" + ("raise Exception('咕咕看吧?')\n" * 800) + "```\n这是材料"
    score, _kind, uncertain = algorithm._scene_score(message(request + long_code), ("咕咕",))
    assert score == pytest.approx(.92)
    assert uncertain is False
    quoted, _, _ = algorithm._scene_score(message("我只是转述：‘咕咕帮我看看’"), ("咕咕",))
    assert quoted == 0
    malformed, _, uncertain = algorithm._scene_score(message("```咕咕看吧"), ("咕咕",))
    assert malformed == 0
    assert uncertain is True


def test_topic_cp_and_local_edit_match_are_v3_compatible():
    cp, coverage, longest = algorithm._cp_similarity("他哪会翻跟斗", "翻个跟斗")
    edit, lengths = algorithm._edit_similarity("他哪会翻跟斗", "翻个跟斗")
    assert 0 < cp < .75
    assert coverage > 0
    assert longest >= 2
    assert edit == pytest.approx(.75)
    assert lengths == (3, 4)
    assert algorithm._edit_similarity("翻个跟斗", "翻个跟斗")[0] == 0
    assert algorithm._edit_similarity("我也这样觉得", "嗯我也这样觉得")[0] == 0
    assert algorithm._edit_similarity("這個", "那个")[0] == 0


def test_topic_cp_containment_still_uses_v302_common_character_and_phrase_formula():
    cp, coverage, longest = algorithm._cp_similarity("我也这样觉得", "嗯我也这样觉得")
    assert cp == pytest.approx(0.7638, abs=0.001)
    assert coverage == 1
    assert longest == len("我也这样觉得")

    single_char, single_coverage, single_longest = algorithm._cp_similarity(
        "是", "那看来限流确实不是偶尔才出现",
    )
    assert single_char == pytest.approx(0.5)
    assert single_coverage == 1
    assert single_longest == 1


@pytest.mark.parametrize("text", [
    "那定个定时任务",
    "帮我创建一个项目",
    "给我记个笔记",
    "把这个笔记删掉",
    "小北帮我整理文件",
    "帮我建个项目",
    "帮我设置提醒",
    "给项目加个任务",
    "我想创建一个项目",
    "好吧 那记录个日程吧",
    "那么记录个笔记吧",
])
def test_capability_action_admits_current_operation_requests(text):
    decision = score_attention(message(text), AttentionSnapshot())

    assert decision.kind is AttentionKind.CAPABILITY_ACTION
    assert decision.score is None
    assert decision.threshold is None
    assert decision.reasons == ("capability_action",)


@pytest.mark.parametrize("text", [
    "我已经 创建项目",
    "他说 创建项目",
    "我打算 创建项目",
    "创建项目 这个功能不错",
    "他让我 创建项目",
    "创建项目真的方便",
])
def test_capability_action_cannot_split_away_clause_level_negative_evidence(text):
    decision = score_attention(message(text), AttentionSnapshot())

    assert decision.kind is AttentionKind.PASSIVE


@pytest.mark.parametrize("text", [
    "创建项目需要注意权限",
    "用户反馈请问如何创建项目",
    "他说创建项目，后来又讨论了权限",
    "文档中创建项目需要注意权限",
    "我已经创建了项目",
    "我准备创建一个项目",
    "创建项目真的方便",
])
def test_capability_action_rejects_descriptive_middle_text_and_reported_requests(text):
    long_text = "背景资料" * 150 + "。" + text + "。" + "补充材料" * 150
    decision = score_attention(message(long_text), AttentionSnapshot())
    assert decision.kind is not AttentionKind.CAPABILITY_ACTION


def test_capability_action_allows_explicit_mid_text_request_and_edge_weak_request():
    explicit = "背景资料" * 250 + "。咕咕帮我创建项目。" + "补充材料" * 250
    explicit_decision = score_attention(message(explicit), AttentionSnapshot())
    assert explicit_decision.kind is AttentionKind.CAPABILITY_ACTION
    assert explicit_decision.capability_strength == "strong"
    assert explicit_decision.capability_position_weight is not None

    edge = "背景资料" * 250 + "。" + "补充材料" * 250 + "。那创建个项目吧"
    edge_decision = score_attention(message(edge), AttentionSnapshot())
    assert edge_decision.kind is AttentionKind.CAPABILITY_ACTION
    assert edge_decision.capability_strength == "weak"


def test_weak_capability_request_keeps_structural_admission_while_exposing_position_diagnostic():
    text = "背景资料" * 250 + "。创建项目。" + "补充材料" * 250
    decision = score_attention(message(text), AttentionSnapshot())
    assert decision.kind is AttentionKind.CAPABILITY_ACTION
    assert decision.capability_strength == "weak"
    assert decision.capability_position_weight == pytest.approx(.55, abs=.01)


@pytest.mark.parametrize(("current", "candidate", "expected"), [
    ("他哪会翻跟斗啊", "翻个跟斗", .75),
    ("他哪会翻跟斗吧", "翻个跟斗", .75),
    ("挺好听", "真好听", 2 / 3),
    ("翻跟斗", "个翻跟斗", 0),
])
def test_edit_candidates_follow_v302_particle_substitution_and_edge_rules(current, candidate, expected):
    actual, _lengths = algorithm._edit_similarity(current, candidate)
    assert actual == pytest.approx(expected)


def test_topic_units_bound_long_text_and_sample_across_it():
    text = "。".join(f"主题片段{index}" for index in range(80))

    units = algorithm._topic_units(text)

    assert len(units) == 4
    assert all(len(unit) <= 64 for unit in units)
    assert units[0] != units[-1]


def test_topic_uses_group_window_accepted_anchor_and_normalized_decay():
    current = message("他哪会翻跟斗")
    snapshot = topic_snapshot("翻个跟斗——来了，落地了", age_s=124.3)
    decision = score_attention(current, snapshot)
    assert decision.state == "TOPIC"
    assert decision.topic_raw_score == pytest.approx(.75)
    assert decision.topic_score == pytest.approx(.6834, abs=.001)
    assert decision.score == pytest.approx(68.34, abs=.1)
    assert decision.kind is AttentionKind.PROACTIVE


def test_deictic_vague_question_keeps_scene_score_when_unrelated_topic_is_active():
    decision = score_attention(message("这咋回事"), topic_snapshot("翻个跟斗", age_s=20))

    assert decision.state == "TOPIC"
    assert decision.scene_type == "ASK"
    assert decision.scene_score == pytest.approx(.765)
    assert decision.topic_score == 0
    assert decision.score == pytest.approx(76.5)


def test_topic_window_includes_members_around_anchor_but_not_current_or_future():
    before = message("火车到站了吗", at_ms=NOW - 35_000, platform_message_id="before")
    after = message("翻个跟斗可以吗", at_ms=NOW - 1_000, platform_message_id="after")
    future = message("翻个跟斗", at_ms=NOW + 5_000, platform_message_id="future")
    current = message("他哪会翻跟斗", at_ms=NOW)
    snap = topic_snapshot("音视频播放有一点延迟", age_s=30, context=(before, after, future))
    result = score_attention(current, snap)
    assert result.topic_match_event_id == f"{NOW - 1_000}-0"
    assert result.topic_match_event_id != f"{NOW + 5_000}-0"


def test_topic_requires_complete_snapshot_and_expires_at_600_seconds():
    current = message("翻跟斗")
    incomplete = replace(topic_snapshot("翻个跟斗"), complete=False)
    expired = topic_snapshot("翻个跟斗", age_s=600)
    assert score_attention(current, incomplete).topic_score == 0
    assert score_attention(current, incomplete).state == "COLD"
    assert score_attention(current, expired).topic_score == 0


def test_topic_requires_delivered_anchor_body():
    current = message("翻跟斗")
    without_body = BotReplyFact("reply-anchor", NOW - 1_000, None, True, delivery_id="delivery-anchor")
    decision = score_attention(current, AttentionSnapshot(complete=True, latest_accepted_final=without_body))
    assert decision.state == "COLD"
    assert decision.topic_score == 0
    assert decision.anchor_event_id is None


def test_fusion_is_noisy_or_and_new_scene_survives_unrelated_topic():
    current = message("Python 连接池超时怎么处理？")
    anchor = topic_snapshot("今晚音乐真好听", age_s=20)
    decision = score_attention(current, anchor)
    assert decision.scene_score == pytest.approx(.9)
    assert decision.score == pytest.approx(90 + (decision.topic_score * 10), abs=1)


def test_structural_routes_precede_scoring_and_reply_needs_verified_recipient():
    native = message("谢谢", native_bot_mentioned=True)
    assert decide_attention(native, AttentionSnapshot(), AttentionMode.QUIET).kind is AttentionKind.DIRECT
    other = message("咕咕看吧", mentions_other_member=True)
    assert decide_attention(other, topic_snapshot("翻跟斗"), AttentionMode.AUTONOMOUS).kind is AttentionKind.EXCLUDED

    reply = message("这个办法为什么有效？", reply_to_message_id="bot-reply", reply_target_is_bot=True)
    trusted = BotReplyFact("bot-reply", NOW - 1000, "member-a", True, final_text="办法")
    result = decide_attention(reply, AttentionSnapshot(complete=False, bot_replies={"bot-reply": trusted}), AttentionMode.NATURAL)
    assert result.kind is AttentionKind.CONTINUE
    wrong_recipient = replace(trusted, recipient_sender_id="member-b")
    untrusted = decide_attention(reply, AttentionSnapshot(complete=False, bot_replies={"bot-reply": wrong_recipient}), AttentionMode.NATURAL)
    assert untrusted.kind is AttentionKind.PROACTIVE


def _member_active_snapshot(*, age_ms: int = 1_000, recipient: str = "member-a",
                            accepted: bool = True, source: str = "DIRECT") -> AttentionSnapshot:
    fact = BotReplyFact(
        "accepted-reply", NOW - age_ms, recipient, accepted,
        source_attention_kind=source, final_text="synthetic final response",
        delivery_id="delivery-member-active",
    )
    return AttentionSnapshot(complete=False, accepted_outbound_facts=(fact,))


def test_same_member_can_continue_with_implicit_request_only_after_accepted_final_reply():
    current = message("改成明天吧")

    result = decide_attention(
        current, _member_active_snapshot(), AttentionMode.NATURAL,
    )

    assert result.kind is AttentionKind.MEMBER_ACTIVE
    assert result.score == 100
    assert result.threshold is None
    assert result.state == "MEMBER_ACTIVE"


@pytest.mark.parametrize(("age_ms", "recipient", "accepted", "source", "expected"), [
    (0, "member-a", True, "DIRECT", AttentionKind.PASSIVE),
    (179_999, "member-a", True, "DIRECT", AttentionKind.MEMBER_ACTIVE),
    (180_000, "member-a", True, "DIRECT", AttentionKind.PASSIVE),
    (1_000, "member-b", True, "DIRECT", AttentionKind.PASSIVE),
    (1_000, "member-a", False, "DIRECT", AttentionKind.PASSIVE),
    (1_000, "member-a", True, "tool", AttentionKind.PASSIVE),
    (-1, "member-a", True, "DIRECT", AttentionKind.PASSIVE),
])
def test_member_active_is_scoped_to_accepted_recipient_and_strict_180_second_ttl(
    age_ms, recipient, accepted, source, expected,
):
    result = decide_attention(
        message("改成明天吧"),
        _member_active_snapshot(age_ms=age_ms, recipient=recipient, accepted=accepted, source=source),
        AttentionMode.NATURAL,
    )

    assert result.kind is expected


def test_member_active_does_not_override_explicit_other_recipient_or_pure_reaction():
    active = _member_active_snapshot()

    other = decide_attention(
        message("小北你看这个", mentions_other_member=True), active, AttentionMode.NATURAL,
    )
    thanks = decide_attention(message("谢谢"), active, AttentionMode.NATURAL)

    assert other.kind is AttentionKind.EXCLUDED
    assert thanks.kind is AttentionKind.PASSIVE


def test_exact_reaction_is_blocked_without_truncating_new_request():
    assert decide_attention(message("谢谢"), topic_snapshot("谢谢"), AttentionMode.ACTIVE).kind is AttentionKind.PASSIVE
    assert decide_attention(message("谢谢，咕咕帮我查"), AttentionSnapshot(), AttentionMode.NATURAL).score == 92
