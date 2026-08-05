from agent.im.models import ChatTarget, PlatformMessage, PlatformReply, normalize_payload
from agent.im.loop import should_record_passive_group
from agent.models import AgentRequest
from worker import _is_passive_group_payload


def test_platform_message_normalizes_group_payload_without_losing_metadata():
    payload = {
        "platform": "qq",
        "channel_id": "bot-1",
        "message_id": "msg-1",
        "chat_id": "group-1",
        "chat_type": "group",
        "platform_user_id": "user-1",
        "platform_user_name": "Coffeiz",
        "text": "你好",
        "attachments": [{"id": "att-1"}],
        "group_mentioned": True,
        "owner_user_id": "gugu-1",
    }

    message = PlatformMessage.from_payload(payload)
    normalized = message.to_payload(payload)

    assert message.chat == ChatTarget(id="group-1", type="group")
    assert message.sender.id == "user-1"
    assert message.sender.name == "Coffeiz"
    assert message.mentioned is True
    assert normalized["owner_user_id"] == "gugu-1"
    assert normalized["attachments"] == [{"id": "att-1"}]


def test_platform_message_preserves_bot_identity_for_session_messages():
    payload = {
        "platform": "qq",
        "bot_id": "42",
        "platform_bot_user_id": "bot-openid-42",
        "chat_type": "group",
        "chat_id": "group-1",
        "platform_user_id": "member-1",
        "message_id": "msg-1",
        "text": "@咕咕 看看这个",
    }

    normalized = normalize_payload(payload)

    assert normalized["bot_id"] == "42"
    assert normalized["platform_bot_user_id"] == "bot-openid-42"


def test_platform_message_uses_sender_as_private_chat_target():
    message = PlatformMessage.from_payload({
        "platform": "wechat",
        "platform_user_id": "user-1",
        "message_id": "msg-1",
        "text": "你好",
    })

    assert message.chat == ChatTarget(id="user-1", type="c2c")
    assert message.mentioned is False
    assert "chat_id" not in normalize_payload({
        "platform": "wechat",
        "platform_user_id": "user-1",
        "message_id": "msg-1",
    })


def test_platform_message_normalizes_feishu_p2p_as_private_chat():
    message = PlatformMessage.from_payload({
        "platform": "feishu",
        "platform_user_id": "ou-user-1",
        "chat_id": "oc-chat-1",
        "chat_type": "p2p",
        "message_id": "om-1",
        "text": "你好",
    })

    assert message.chat == ChatTarget(id="oc-chat-1", type="c2c")
    assert normalize_payload({
        "platform": "feishu",
        "platform_user_id": "ou-user-1",
        "chat_id": "oc-chat-1",
        "chat_type": "p2p",
        "message_id": "om-1",
    })["chat_type"] == "c2c"

def test_platform_message_normalizes_wechat_group_id():
    payload = {
        "platform": "wechat",
        "channel_id": "bot-1",
        "platform_user_id": "member-1",
        "wechat_group_id": "wx-group-1",
        "chat_type": "group",
        "message_id": "msg-1",
        "text": "群消息",
    }

    message = PlatformMessage.from_payload(payload)
    normalized = normalize_payload(payload)

    assert message.bot_id == "bot-1"
    assert message.chat == ChatTarget(id="wx-group-1", type="group")
    assert normalized["chat_id"] == "wx-group-1"
    assert normalized["wechat_group_id"] == "wx-group-1"


def test_extract_platform_user_id_supports_nested_platform_payloads():
    from agent.im.models import extract_platform_user_id

    assert extract_platform_user_id({"platform_user_id": "direct"}) == "direct"
    assert extract_platform_user_id({"author": {"member_openid": "qq-member"}}) == "qq-member"
    assert extract_platform_user_id({"sender": {"sender_id": {"open_id": "feishu-user"}}}) == "feishu-user"
    assert extract_platform_user_id({"from_user": "wechat-user"}) == "wechat-user"


def test_platform_reply_keeps_platform_neutral_parts():
    reply = PlatformReply(
        target=ChatTarget(id="group-1", type="group"),
        parts=[{"type": "text", "text": "完成啦"}],
        reply_to_message_id="msg-1",
    )

    assert reply.target.type == "group"
    assert reply.parts[0]["type"] == "text"


def test_platform_reply_from_text_preserves_group_reply_route():
    reply = PlatformReply.from_text({
        "platform": "qq",
        "chat_type": "group",
        "chat_id": "group-1",
        "platform_user_id": "user-1",
        "message_id": "msg-1",
    }, "完成啦")

    assert reply.target == ChatTarget(id="group-1", type="group")
    assert reply.reply_to_message_id == "msg-1"
    assert reply.text == "完成啦"


def test_record_only_group_policy_matches_all_qq_messages():
    request = AgentRequest(
        message="群里的普通消息",
        user_id="owner-1",
        user_name="owner",
        chat_id="group-1",
        source="qq",
    )
    base = {"chat_type": "group", "group_read_enabled": True}

    assert should_record_passive_group(request, base) is True
    assert should_record_passive_group(request, {**base, "group_mentioned": True}) is True
    request.source = "feishu"
    assert should_record_passive_group(request, base) is False


def test_reply_mentions_records_unmentioned_qq_messages_without_replying():
    request = AgentRequest(
        message="群里的普通消息",
        user_id="owner-1",
        user_name="owner",
        chat_id="group-1",
        source="qq",
    )
    policy = {
        "chat_type": "group",
        "group_requires_at": True,
        "group_read_enabled": False,
        "group_mentioned": False,
    }

    assert should_record_passive_group(request, policy) is True
    assert should_record_passive_group(
        request, {**policy, "group_mentioned": True}
    ) is False
    assert should_record_passive_group(
        request, {**policy, "group_requires_at": False}
    ) is False


def test_passive_group_payload_can_bypass_active_agent_task():
    base = {
        "platform": "qq",
        "chat_type": "group",
        "chat_id": "group-1",
    }

    assert _is_passive_group_payload({**base, "group_read_enabled": True}) is True
    assert _is_passive_group_payload({
        **base,
        "group_requires_at": True,
        "group_mentioned": False,
    }) is True
    assert _is_passive_group_payload({
        **base,
        "group_requires_at": True,
        "group_mentioned": True,
    }) is False
    assert _is_passive_group_payload({**base, "group_requires_at": False}) is False
