"""ImConversationKey / conversation_key() 回归测试。

PRD-IM-2 Phase 5 §1 P1：worker 的防抖 buffer、串行锁只用 platform_user_id
当 key 时，同一用户跨 bot、跨群或私聊/群聊同时发消息，可能被误合并到同一轮
处理、共用同一把锁。这里验证 conversation_key() 对这几类场景都能算出不同的
key——防抖/锁本身的正确性由此机械地跟着成立，不需要再跑完整 worker 集成。
"""
from agent.im.session import conversation_key


def _payload(**overrides) -> dict:
    base = {
        "platform": "qq",
        "bot_id": "bot-1",
        "chat_type": "group",
        "chat_id": "group-1",
        "platform_user_id": "member-1",
    }
    base.update(overrides)
    return base


def test_same_user_same_group_same_bot_shares_key():
    a = conversation_key(_payload())
    b = conversation_key(_payload())
    assert a == b


def test_same_user_different_groups_do_not_share_key():
    a = conversation_key(_payload(chat_id="group-1"))
    b = conversation_key(_payload(chat_id="group-2"))
    assert a != b


def test_same_user_group_and_private_do_not_share_key():
    group = conversation_key(_payload(chat_type="group", chat_id="group-1"))
    private = conversation_key(_payload(chat_type="c2c", chat_id=None))
    assert group != private


def test_same_user_different_bots_do_not_share_key():
    a = conversation_key(_payload(bot_id="bot-1"))
    b = conversation_key(_payload(bot_id="bot-2"))
    assert a != b


def test_private_chat_uses_sender_as_scope_id():
    key = conversation_key(_payload(chat_type="c2c", chat_id=None, platform_user_id="member-1"))
    assert key.scope_id == "member-1"
    assert key.chat_type == "c2c"


def test_missing_routing_fields_still_produces_a_key_without_raising():
    key = conversation_key({"platform": "qq"})
    assert key.platform == "qq"
    assert key.scope_id == ""
