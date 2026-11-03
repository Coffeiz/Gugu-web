"""锁定三个 Gateway 仅使用原生结构字段生成注意力事实。"""
from types import SimpleNamespace


def test_qq_attention_facts_require_current_bot_identity_and_scoped_reply_index(
    tmp_path, monkeypatch,
):
    from agent.gateway.qq.events import (
        _qq_attention_mention_facts,
        _qq_attention_reply_facts,
    )
    from agent.im.qq_ref_index import QQRefIndex, ref_index_key

    monkeypatch.setenv("QQ_REF_INDEX_DIR", str(tmp_path))
    assert _qq_attention_mention_facts(
        {"mentions": [{"bot": True, "is_you": True}]}, "GROUP_AT_MESSAGE_CREATE",
    ) == (True, False, False, False)
    assert _qq_attention_mention_facts(
        {"mentions": [{"bot": True}]}, "GROUP_AT_MESSAGE_CREATE",
    ) == (None, None, None, True)

    index = QQRefIndex(owner="owner-fixture", bot_id="bot-fixture")
    index.set(ref_index_key("group", "group-1", "member-1", "ref-1"), {
        "sender_id": "bot-user-1", "sender_is_bot": True,
    })
    data = {"message_scene": {"ext": [{"ref_msg_idx": "ref-1"}]}}
    assert _qq_attention_reply_facts(index, data, "group", "group-1", "member-1") == (
        "ref-1", "bot-user-1", True,
    )
    assert _qq_attention_reply_facts(index, data, "group", "other-group", "member-1") == (
        "ref-1", None, None,
    )


def test_feishu_attention_facts_resolve_structured_open_ids_only():
    from agent.gateway.feishu.events import _feishu_attention_mention_facts

    current = SimpleNamespace(open_id="bot-open-id")
    other_bot = SimpleNamespace(open_id="other-bot-id")
    assert _feishu_attention_mention_facts(SimpleNamespace(mentions=[{
        "id": current, "is_bot": True,
    }]), "bot-open-id") == (True, False, False, False)
    assert _feishu_attention_mention_facts(SimpleNamespace(mentions=[{
        "id": other_bot, "is_bot": True,
    }]), "bot-open-id") == (False, True, True, False)
    assert _feishu_attention_mention_facts(SimpleNamespace(mentions=[{}]), "bot-open-id") == (
        None, None, None, True,
    )


def test_telegram_native_reply_facts_keep_unknown_sender_kind_unknown():
    from agent.im.parsers.telegram import normalize_message

    update = {
        "update_id": 12,
        "message": {
            "message_id": 40,
            "date": 1_791_000_000,
            "chat": {"id": -1001, "type": "supergroup"},
            "from": {"id": 7001, "first_name": "Fixture"},
            "text": "继续查这个错误",
            "reply_to_message": {
                "message_id": 39,
                "from": {"id": 9001, "is_bot": True},
                "text": "上一条回复",
            },
        },
    }
    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot",
    )
    assert payload["reply_to_platform_message_id"] == "39"
    assert payload["reply_target_sender_id"] == "9001"
    assert payload["reply_target_is_bot"] is True

    del update["message"]["reply_to_message"]["from"]["is_bot"]
    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot",
    )
    assert payload["reply_target_sender_id"] == "9001"
    assert payload["reply_target_is_bot"] is None
