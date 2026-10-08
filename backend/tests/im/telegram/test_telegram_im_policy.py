"""Telegram 群策略、身份授权与上下文范围回归。"""

import pytest

from agent.im import loop as im_loop
from agent.im.actor import ActorContext
from agent.models import AgentRequest
from app.models import ConversationMessage, ConversationSession, UserBot
from worker import _hydrate_group_policy, _is_passive_group_payload


@pytest.mark.asyncio
async def test_telegram_owner_member_and_unknown_roles_are_bound_to_their_bot(db, user_a, user_b):
    from agent.im.permissions import resolve_access

    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9001",
        owner_platform_user_id="7001",
        group_allowed_tools=["group_context_search"],
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    owner = await resolve_access("telegram", "group", str(bot.id), user_a.id, "7001")
    member = await resolve_access("telegram", "group", str(bot.id), user_a.id, "7002")
    missing_identity = await resolve_access("telegram", "group", str(bot.id), user_a.id, "")
    wrong_owner = await resolve_access("telegram", "group", str(bot.id), user_b.id, "7001")
    assert owner.role == "owner"
    assert owner.allowed_tool_names is None
    assert member.role == "member"
    assert member.allowed_tool_names == ["group_context_search"]
    assert missing_identity.role == "unknown"
    assert wrong_owner.role == "unknown"


@pytest.mark.asyncio
async def test_telegram_group_settings_hydrate_worker_passive_recording_and_reply_rules(db, user_a):
    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9001",
        group_chat_enabled=True,
        group_requires_at=True,
        group_read_enabled=True,
        group_memory_enabled=False,
        member_memory_enabled=False,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    payload = await _hydrate_group_policy({
        "platform": "telegram",
        "channel_id": str(bot.id),
        "chat_type": "group",
        "chat_id": "-1007002",
        "group_mentioned": False,
    })

    assert payload["group_read_enabled"] is True
    assert payload["group_memory_enabled"] is False
    assert payload["member_memory_enabled"] is False
    assert _is_passive_group_payload(payload) is True
    assert im_loop.should_record_passive_group(
        AgentRequest(message="ordinary message", user_id=user_a.id, user_name="合成用户",
                     source="telegram", chat_id="-1007002"),
        payload,
    ) is True
    assert _is_passive_group_payload({**payload, "group_read_enabled": False, "group_mentioned": True}) is False


@pytest.mark.parametrize(
    ("group_read_enabled", "group_requires_at", "mentioned", "passive"),
    [
        (True, False, False, True),   # record_only: 记录所有已投递消息
        (False, True, False, True),   # reply_mentions: 记录未触发回复的消息
        (False, True, True, False),  # 被提及时进入正常回复流程
        (False, False, False, False),  # reply_all: 不把消息误分到被动记录
    ],
)
def test_telegram_group_response_modes_keep_passive_message_semantics(
    group_read_enabled, group_requires_at, mentioned, passive,
):
    request = AgentRequest(
        message="synthetic group message", user_id="owner-1", user_name="合成用户",
        source="telegram", chat_id="-1007002",
    )
    payload = {
        "chat_type": "group",
        "group_read_enabled": group_read_enabled,
        "group_requires_at": group_requires_at,
        "group_mentioned": mentioned,
    }

    assert im_loop.should_record_passive_group(request, payload) is passive


@pytest.mark.asyncio
async def test_telegram_owner_group_memory_requires_verified_owner_and_explicit_setting(db, user_a):
    from agent.im.permissions import resolve_group_owner_memory

    bot = UserBot(
        user_id=user_a.id,
        platform="telegram",
        app_id="9001",
        group_owner_memory_enabled=True,
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    owner = ActorContext(user_a.id, "telegram", role="owner", chat_type="group")
    member = ActorContext(user_a.id, "telegram", role="member", chat_type="group")
    other_platform = ActorContext(user_a.id, "qq", role="owner", chat_type="group")

    assert await resolve_group_owner_memory(owner, str(bot.id)) is True
    assert await resolve_group_owner_memory(member, str(bot.id)) is False
    assert await resolve_group_owner_memory(other_platform, str(bot.id)) is False


@pytest.mark.asyncio
async def test_telegram_group_context_search_never_crosses_platform_bot_or_chat(db, user_a):
    from agent.im import imctx
    from agent.tools.group_context import _group_context_search

    current = ConversationSession(
        user_id=user_a.id, source="telegram", bot_id="41", chat_type="group",
        chat_id="-1007002", title="当前 Telegram 群",
    )
    other_platform = ConversationSession(
        user_id=user_a.id, source="qq", bot_id="41", chat_type="group",
        chat_id="-1007002", title="相同 ID 的 QQ 群",
    )
    other_bot = ConversationSession(
        user_id=user_a.id, source="telegram", bot_id="42", chat_type="group",
        chat_id="-1007002", title="另一个 Bot 的群",
    )
    other_chat = ConversationSession(
        user_id=user_a.id, source="telegram", bot_id="41", chat_type="group",
        chat_id="-1007003", title="另一个 Telegram 群",
    )
    db.add_all([current, other_platform, other_bot, other_chat])
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=session.id, role="user", content=f"独立范围标记 {index}")
        for index, session in enumerate([current, other_platform, other_bot, other_chat])
    ])
    await db.commit()
    imctx.set_im("telegram", "member-1", "41", "-1007002", "member", "group")
    try:
        result = await _group_context_search(db, user_a.id, {"query": "独立范围标记"})
    finally:
        imctx.clear()

    assert [message["content"] for message in result["messages"]] == ["独立范围标记 0"]
