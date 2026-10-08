"""Telegram 事件解析的用户可观察契约：身份、命令目标与 UTF-16 偏移。"""

import pytest

from agent.im.parsers.telegram import normalize_command, normalize_message


def _update(text: str, *, chat_type: str = "private", sender=None, entities=None, reply=None):
    message = {
        "message_id": 31,
        "date": 1_791_000_000,
        "chat": {"id": 7001 if chat_type == "private" else -1007002, "type": chat_type},
        "from": sender or {"id": 7001, "first_name": "测试", "username": "sample_user"},
        "text": text,
        "entities": entities or [],
    }
    if reply is not None:
        message["reply_to_message"] = reply
    return {"update_id": 91, "message": message}


def test_normalize_private_text_keeps_platform_identity_and_display_name():
    payload = normalize_message(_update("你好"), bot_id="41", owner_id="owner-1", bot_username="gugu_bot")

    assert payload["platform"] == "telegram"
    assert payload["chat_type"] == "c2c"
    assert payload["chat_id"] == "7001"
    assert payload["platform_user_id"] == "7001"
    assert payload["platform_user_name"] == "测试"
    assert payload["text"] == "你好"


def test_bot_command_uses_utf16_entity_offset_and_strips_only_own_username():
    text = "😀 /bind 123456"
    command = {"type": "bot_command", "offset": 3, "length": 5}
    assert normalize_command(text, [command], "gugu_bot") == ("bind", "123456")
    assert normalize_command("/start@other_bot", [{"type": "bot_command", "offset": 0, "length": 16}], "gugu_bot") is None
    assert normalize_command("/start@GUGU_BOT", [{"type": "bot_command", "offset": 0, "length": 15}], "gugu_bot") == ("start", "")


def test_anonymous_and_bot_sender_are_rejected_but_supported_media_is_kept():
    anonymous = _update("群消息", chat_type="group", sender=None)
    anonymous["message"]["from"] = None
    anonymous["message"]["sender_chat"] = {"id": -1007999, "title": "匿名频道"}
    bot_sender = _update("机器人消息", sender={"id": 9001, "is_bot": True})
    no_text = _update("")
    media_only = _update("")
    media_only["message"]["photo"] = [{"file_id": "synthetic-file", "file_unique_id": "synthetic-unique"}]

    assert normalize_message(anonymous, bot_id="41", owner_id="owner-1", bot_username="gugu_bot") is None
    assert normalize_message(bot_sender, bot_id="41", owner_id="owner-1", bot_username="gugu_bot") is None
    assert normalize_message(no_text, bot_id="41", owner_id="owner-1", bot_username="gugu_bot") is None
    normalized_media = normalize_message(
        media_only, bot_id="41", owner_id="owner-1", bot_username="gugu_bot"
    )
    assert normalized_media["attachments"][0]["file_id"] == "synthetic-file"


def test_reply_to_bot_counts_as_mention_and_message_id_is_chat_scoped():
    update = _update("继续", chat_type="group", reply={
        "message_id": 30,
        "from": {"id": 9001, "is_bot": True},
        "text": "上一条",
    })
    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot", bot_platform_id="9001"
    )

    assert payload["chat_type"] == "group"
    assert payload["bot_mentioned"] is True
    assert payload["group_mentioned"] is True
    assert payload["reply_to_message_id"] == "30"
    assert payload["quoted_text"] == "上一条"


def test_mention_entity_matches_bot_identity_not_display_text():
    update = _update("嗨 @gugu_bot", chat_type="group", entities=[
        {"type": "mention", "offset": 2, "length": 9},
    ])
    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot", bot_platform_id="9001"
    )
    assert payload["bot_mentioned"] is True

    update["message"]["entities"] = [{"type": "mention", "offset": 2, "length": 8}]
    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot", bot_platform_id="9001"
    )
    assert payload["bot_mentioned"] is False


def test_current_bot_mention_is_displayed_as_gugu_without_renaming_other_bots():
    text = "我在问 @GUGUTEST1BOT 我是谁；另一个是 @other_bot，也不是 @Gugutest1botExtra"
    update = _update(text, chat_type="group", entities=[
        {"type": "mention", "offset": 4, "length": 13},
    ])

    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugutest1bot",
        bot_platform_id="9001",
    )

    assert payload["text"] == "我在问 @咕咕 我是谁；另一个是 @other_bot，也不是 @Gugutest1botExtra"
    assert payload["bot_mentioned"] is True


def test_privacy_mode_command_or_reply_is_a_trigger_but_other_bot_command_is_not():
    generic_command = _update("/start", chat_type="group", entities=[
        {"type": "bot_command", "offset": 0, "length": 6},
    ])
    own_command = _update("/help@gugu_bot", chat_type="group", entities=[
        {"type": "bot_command", "offset": 0, "length": 14},
    ])
    other_command = _update("/help@other_bot", chat_type="group", entities=[
        {"type": "bot_command", "offset": 0, "length": 15},
    ])

    generic = normalize_message(generic_command, bot_id="41", owner_id="owner-1", bot_username="gugu_bot")
    own = normalize_message(own_command, bot_id="41", owner_id="owner-1", bot_username="gugu_bot")

    assert generic["group_mentioned"] is True
    assert own["group_mentioned"] is True
    assert normalize_message(other_command, bot_id="41", owner_id="owner-1", bot_username="gugu_bot") is None


def test_normalize_media_keeps_caption_file_metadata_and_chat_scoped_quote_reference():
    update = _update("", chat_type="group")
    update["message"].update({
        "caption": "请看看这张图",
        "caption_entities": [],
        "message_id": 55,
        "photo": [
            {"file_id": "small-photo", "file_size": 100},
            {"file_id": "large-photo", "file_size": 900},
        ],
        "reply_to_message": {
            "message_id": 54,
            "chat": {"id": -1007002, "type": "supergroup"},
            "from": {"id": 7002, "first_name": "合成成员"},
            "document": {
                "file_id": "quoted-doc", "file_size": 25,
                "file_name": "notes.txt", "mime_type": "text/plain",
            },
        },
    })
    payload = normalize_message(
        update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot"
    )

    assert payload["text"] == "请看看这张图"
    assert payload["attachments"] == [{
        "file_id": "large-photo", "file_size": 900, "file_name": "图片.jpg",
        "mime_type": "image/jpeg", "media_type": "photo", "source_attachment_index": 0,
    }]
    assert payload["attachment_source_message_id"] == "41:-1007002:55"
    assert payload["quoted_text"] == "[document 附件]"
    assert payload["quoted_attachments"][0]["source_platform_message_id"] == "41:-1007002:54"


def test_media_only_message_is_kept_and_unsupported_empty_event_is_ignored():
    media = _update("", chat_type="private")
    media["message"]["document"] = {
        "file_id": "synthetic-file", "file_size": 4,
        "file_name": "sample.txt", "mime_type": "text/plain",
    }
    empty = _update("", chat_type="private")

    payload = normalize_message(media, bot_id="41", owner_id="owner-1", bot_username="gugu_bot")
    assert payload["text"] == ""
    assert payload["attachments"][0]["file_id"] == "synthetic-file"
    assert normalize_message(empty, bot_id="41", owner_id="owner-1", bot_username="gugu_bot") is None


@pytest.mark.parametrize(
    ("field", "media_type"),
    [("document", "document"), ("audio", "audio"), ("voice", "voice"),
     ("video", "video"), ("animation", "animation"), ("video_note", "video_note")],
)
def test_normalize_supported_telegram_media_fields(field, media_type):
    update = _update("", chat_type="private")
    update["message"][field] = {
        "file_id": f"synthetic-{media_type}", "file_size": 10,
        "file_name": "recording.ogg", "mime_type": "application/octet-stream",
    }

    payload = normalize_message(update, bot_id="41", owner_id="owner-1", bot_username="gugu_bot")

    assert payload["attachments"][0]["media_type"] == media_type
    assert payload["attachments"][0]["file_id"] == f"synthetic-{media_type}"
