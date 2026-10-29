"""保护注意力门控的高置信特征与逐条输入契约。"""
from dataclasses import replace

import pytest

from agent.im.auto_reply.attention import (
    AttentionInputError,
    AttentionMessage,
    AttentionSnapshot,
    BotReplyFact,
    _hard_reject,
    normalize_text,
    score_open_candidate,
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
        "reply_to_platform_message_id": None,
        "reply_target_sender_id": None,
        "reply_target_is_bot": None,
        "quote_text": None,
        "sender_is_bot": False,
    }
    values.update(overrides)
    return AttentionMessage(**values)


def test_payload_uses_stream_id_for_arrival_time_and_does_not_guess_missing_facts():
    item = AttentionMessage.from_payload("1761746400123-7", {
        "platform": "telegram",
        "channel_id": "bot-2",
        "chat_id": "group-9",
        "platform_user_id": "member-9",
        "message_id": "42",
        "text": "这条消息",
        "attachments": [{"mime_type": "image/jpeg"}],
        "received_at": 1_761_746_000,
        "bot_mentioned": False,
    })

    assert item.event_id == "1761746400123-7"
    assert item.event_received_ms == 1_761_746_400_123
    assert item.platform_sent_ms == 1_761_746_000_000
    assert item.platform_message_id == "42"
    assert item.media_kinds == ("image",)
    assert item.processable_media is None
    assert item.mentioned_other_member is None
    assert item.reply_target_is_bot is None


@pytest.mark.parametrize("event_id", ["", "bad-0", "0-0", "12345"])
def test_payload_rejects_untrusted_or_missing_stream_arrival_time(event_id):
    with pytest.raises(AttentionInputError):
        AttentionMessage.from_payload(event_id, {})


def test_normalization_only_removes_formatting_not_message_identity():
    assert normalize_text("  Python　配置？ ") == "python配置"


def test_hard_reject_short_reaction_other_mention_and_other_reply():
    snapshot = AttentionSnapshot(complete=True)
    assert _hard_reject(message(raw_text="哈哈",), snapshot, False) == "H02_short_reaction"
    assert _hard_reject(message(raw_text="@同事 看下这个", mentioned_other_member=True), snapshot, False) == "H03_other_mention"
    assert _hard_reject(message(
        raw_text="这个问题怎么解决？",
        reply_to_platform_message_id="other-message",
        reply_target_is_bot=False,
    ), snapshot, False) == "H04_reply_to_other"


def test_hard_reject_only_uses_high_precision_untargeted_and_social_phrases():
    snapshot = AttentionSnapshot(complete=True)
    assert _hard_reject(message(raw_text="帮我看看"), snapshot, False) == "H05_untargeted_command"
    assert _hard_reject(message(raw_text="这也太离谱了"), snapshot, False) == "H06_social_expression"
    assert _hard_reject(message(raw_text="日志报错了，怎么解决？"), snapshot, False) is None


def test_media_is_classified_from_structured_attachment_metadata():
    item = AttentionMessage.from_payload("1761746400123-0", {
        "text": "",
        "attachments": [{"media_type": "voice"}],
    })
    assert item.media_only is True
    assert item.media_kinds == ("voice",)
    assert _hard_reject(item, AttentionSnapshot(complete=True), False) == "H01_media_only"


def test_solved_question_hard_reject_requires_same_question_owner():
    snapshot = AttentionSnapshot(
        complete=True,
        resolved_question_ids=frozenset({"question-1"}),
        question_owners={"question-1": "member-1"},
    )
    resolved = message(
        raw_text="已经解决了",
        reply_to_platform_message_id="question-1",
        reply_target_sender_id="member-1",
    )
    other = replace(resolved, sender_id="member-2")
    assert _hard_reject(resolved, snapshot, False) == "H08_question_resolved"
    assert _hard_reject(other, snapshot, False) is None


def test_open_question_score_uses_only_available_features_and_fixed_weights():
    current = message(raw_text="有谁能推荐一下咖啡豆？")
    recent_human = message(
        event_id="1761746399000-1",
        event_received_ms=current.event_received_ms - 1_000,
        sender_id="member-2",
        raw_text="最近在看咖啡机",
    )
    score, reasons = score_open_candidate(
        current,
        AttentionSnapshot(messages=(recent_human,), complete=True, watermark_ms=current.event_received_ms),
    )
    assert score == 65
    assert "P01_group_broadcast_request" in reasons
    assert "P02_substantive_question" in reasons
    assert "P05_quiet_conversation" not in reasons
    assert "P04_unanswered_observed" not in reasons


def test_peer_exchange_is_negative_and_unknown_history_does_not_add_positive_score():
    current = message(raw_text="Python 配置怎么设置？")
    base = score_open_candidate(current, AttentionSnapshot(complete=True))[0]
    incomplete = score_open_candidate(current, AttentionSnapshot(complete=False))
    assert base >= 0
    assert incomplete == (0, ("snapshot_incomplete",))

    history = tuple(
        message(
            event_id=f"{current.event_received_ms - offset}-0",
            event_received_ms=current.event_received_ms - offset,
            sender_id=sender,
            raw_text=f"对话{index}",
            reply_to_platform_message_id=f"reply-{index}" if index else None,
        )
        for index, (sender, offset) in enumerate((("a", 3000), ("b", 2000), ("a", 1000)))
    )
    peer_score, reasons = score_open_candidate(
        current, AttentionSnapshot(messages=history, complete=True, watermark_ms=current.event_received_ms)
    )
    assert peer_score <= base
    assert "N01_strong_peer_exchange" in reasons
