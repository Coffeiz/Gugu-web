"""Phase 0 IM 契约：Telegram 身份、会话隔离与默认关闭。"""

from types import SimpleNamespace

import pytest

from agent.im.models import PlatformMessage
from agent.im.session import conversation_key, get_or_create_session
from agent.models import AgentRequest


def test_telegram_private_and_supergroup_types_map_to_shared_im_protocol():
    private = PlatformMessage.from_payload({
        "platform": "telegram",
        "channel_id": "41",
        "chat_type": "private",
        "chat_id": "7001",
        "platform_user_id": "7001",
        "message_id": "9",
    })
    group = PlatformMessage.from_payload({
        "platform": "telegram",
        "channel_id": "41",
        "chat_type": "supergroup",
        "chat_id": "-1007002",
        "platform_user_id": "7003",
        "message_id": "10",
    })

    assert private.chat.type == "c2c"
    assert private.chat.id == "7001"
    assert group.chat.type == "group"
    assert group.chat.id == "-1007002"


def test_same_telegram_chat_id_does_not_collide_across_platform_or_bot():
    telegram = conversation_key({
        "platform": "telegram", "bot_id": "41", "chat_type": "group",
        "chat_id": "-1007002", "platform_user_id": "7003",
    })
    qq = conversation_key({
        "platform": "qq", "bot_id": "41", "chat_type": "group",
        "chat_id": "-1007002", "platform_user_id": "7003",
    })
    another_bot = conversation_key({
        "platform": "telegram", "bot_id": "42", "chat_type": "group",
        "chat_id": "-1007002", "platform_user_id": "7003",
    })

    assert telegram != qq
    assert telegram != another_bot


@pytest.mark.asyncio
async def test_telegram_group_sessions_reuse_only_the_same_platform_bot_and_chat(db, user_a):
    def request(source: str, bot_id: str, chat_id: str) -> AgentRequest:
        return AgentRequest(
            message="synthetic message",
            user_id=user_a.id,
            user_name="合成用户",
            source=source,
            platform_bot_id=bot_id,
            platform_user_id="7003",
            chat_id=chat_id,
        )

    telegram_a = await get_or_create_session(
        db, request("telegram", "41", "-1007002"), user_a.id
    )
    telegram_a_again = await get_or_create_session(
        db, request("telegram", "41", "-1007002"), user_a.id
    )
    telegram_other_bot = await get_or_create_session(
        db, request("telegram", "42", "-1007002"), user_a.id
    )
    qq_same_external_id = await get_or_create_session(
        db, request("qq", "41", "-1007002"), user_a.id
    )

    assert telegram_a.session.id == telegram_a_again.session.id
    assert telegram_a.session.id != telegram_other_bot.session.id
    assert telegram_a.session.id != qq_same_external_id.session.id


@pytest.mark.asyncio
async def test_new_telegram_bot_persists_group_chat_disabled_by_default(db, user_a):
    from app.models import UserBot
    from agent.im.permissions import resolve_group_policy

    bot = UserBot(user_id=user_a.id, platform="telegram", app_id="9001")
    db.add(bot)
    await db.flush()

    assert bot.group_chat_enabled is False
    assert (await resolve_group_policy(str(bot.id), "telegram"))[0] is False


@pytest.mark.asyncio
async def test_telegram_group_message_is_stopped_before_agent_when_group_policy_is_closed(monkeypatch):
    from agent.im import loop

    async def closed_policy(_bot_id, *, platform):
        assert platform == "telegram"
        return False, True, False, True, True

    monkeypatch.setattr(loop, "resolve_group_policy", closed_policy)
    result = await loop.dispatch_im_message({
        "platform": "telegram",
        "channel_id": "41",
        "chat_type": "group",
        "chat_id": "-1007002",
        "platform_user_id": "7003",
        "text": "synthetic message",
    })

    assert result is None


@pytest.mark.asyncio
async def test_telegram_bind_command_is_consumed_before_agent_and_confirms_in_private_chat(
    monkeypatch, user_a,
):
    from agent.im import loop
    from agent.gateway import telegram
    from app.core import events
    from app.services import im_identity

    consumed = []
    sent = []
    bumped = []

    async def consume(bot_id, owner_user_id, platform_user_id, code):
        consumed.append((bot_id, owner_user_id, platform_user_id, code))
        return True

    async def send(chat_id, text, *, channel_id, reply_to_message_id=None):
        sent.append((chat_id, text, channel_id, reply_to_message_id))
        return True

    async def bump(user_id, _domain):
        bumped.append(user_id)

    async def should_not_enter_agent(*_args, **_kwargs):
        raise AssertionError("/bind must not enter the Agent path")

    monkeypatch.setattr(im_identity, "consume_telegram_binding_code", consume)
    monkeypatch.setattr(telegram, "send_message", send)
    monkeypatch.setattr(events, "bump_context_revision", bump)
    monkeypatch.setattr(loop, "prepare_message", should_not_enter_agent)

    result = await loop.dispatch_im_message({
        "platform": "telegram",
        "channel_id": "41",
        "owner_user_id": str(user_a.id),
        "chat_type": "c2c",
        "chat_id": "7001",
        "platform_user_id": "7001",
        "message_id": "32",
        "telegram_command": "bind",
        "text": "/bind 123456",
    })

    assert result is None
    assert consumed == [(41, user_a.id, "7001", "123456")]
    assert sent == [
        ("7001", "绑定成功。", "41", "32"),
    ]
    assert bumped == [user_a.id]


@pytest.mark.asyncio
async def test_telegram_text_reply_uses_telegram_gateway_and_replies_to_inbound_message(monkeypatch):
    from agent.gateway import telegram
    from agent.im.models import PlatformReply
    from agent.im.replies import send_reply

    sent = []

    async def send_message(chat_id, text, *, channel_id, reply_to_message_id=None):
        sent.append((chat_id, text, channel_id, reply_to_message_id))
        return True

    monkeypatch.setattr(telegram, "send_message", send_message)
    payload = {
        "platform": "telegram",
        "channel_id": "41",
        "chat_type": "c2c",
        "platform_user_id": "7001",
        "message_id": "32",
    }
    reply = PlatformReply.from_text(payload, "你好，收到。")

    assert await send_reply(payload, reply) is True
    assert sent == [("7001", "你好，收到。", "41", "32")]


@pytest.mark.parametrize("command", ["/stop", "/cancel"])
@pytest.mark.asyncio
async def test_telegram_stop_commands_cancel_only_their_bot_private_session(monkeypatch, command):
    from agent.im import loop
    from agent.runtime import runtime_state

    requests = []

    async def state(platform, bot_id, scope_id, _platform_user_id):
        assert (platform, bot_id, scope_id) == ("telegram", "41", "7001")
        return "thinking"

    async def awaiting(_platform, _platform_user_id):
        return False

    async def active(platform, bot_id, scope_id):
        assert (platform, bot_id, scope_id) == ("telegram", "41", "7001")
        return {"7001"}

    async def request_cancel(*args):
        requests.append(args)
        return True

    monkeypatch.setattr(runtime_state, "get_state", state)
    monkeypatch.setattr(runtime_state, "is_awaiting", awaiting)
    monkeypatch.setattr(runtime_state, "get_active", active)
    monkeypatch.setattr(runtime_state, "request_cancel", request_cancel)

    decision = await loop.decide_im_shortcut(
        "telegram", "7001", command, bot_id="41", scope_id="7001"
    )
    await loop.apply_im_shortcut_cancel(
        "telegram", "7001", decision, bot_id="41", scope_id="7001"
    )

    assert decision["action"] == "cancel"
    assert requests == [("telegram", "41", "7001", "7001")]


@pytest.mark.asyncio
async def test_telegram_group_stop_is_scoped_to_the_current_bot_and_group(monkeypatch):
    from agent.im import loop
    from agent.runtime import runtime_state

    requests = []

    async def state(platform, bot_id, scope_id, _platform_user_id):
        assert (platform, bot_id, scope_id) == ("telegram", "41", "-1007002")
        return "thinking"

    async def awaiting(_platform, _platform_user_id):
        return False

    async def active(platform, bot_id, scope_id):
        assert (platform, bot_id, scope_id) == ("telegram", "41", "-1007002")
        return {"7003"}

    async def request_cancel(*args):
        requests.append(args)
        return True

    monkeypatch.setattr(runtime_state, "get_state", state)
    monkeypatch.setattr(runtime_state, "is_awaiting", awaiting)
    monkeypatch.setattr(runtime_state, "get_active", active)
    monkeypatch.setattr(runtime_state, "request_cancel", request_cancel)

    decision = await loop.decide_im_shortcut(
        "telegram", "7003", "/stop", bot_id="41", scope_id="-1007002"
    )
    await loop.apply_im_shortcut_cancel(
        "telegram", "7003", decision, bot_id="41", scope_id="-1007002"
    )

    assert decision["action"] == "cancel"
    assert requests == [("telegram", "41", "-1007002", "7003")]


@pytest.mark.asyncio
async def test_telegram_anonymous_sender_and_unbound_private_sender_fail_closed(monkeypatch):
    import app.db.session as db_session
    from agent.im.actor import ActorResolver
    from agent.im.context_policy import policy_for
    from agent.im.permissions import resolve_access
    from agent.models import AgentRequest

    bot = SimpleNamespace(
        platform="telegram",
        user_id="owner-1",
        owner_platform_user_id="7001",
        group_allowed_tools=["web_search"],
    )

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def get(self, _model, _bot_id):
            return bot

    monkeypatch.setattr(db_session, "_engine", object())
    monkeypatch.setattr(db_session, "_SessionLocal", Session)

    anonymous_payload = {
        "platform": "telegram",
        "channel_id": "41",
        "chat_type": "group",
        "chat_id": "-1007002",
        "sender_chat": {"id": "-1007999", "title": "匿名频道"},
    }
    anonymous_message = PlatformMessage.from_payload(anonymous_payload)
    anonymous_actor = await ActorResolver().resolve(
        anonymous_message, anonymous_payload, "owner-1"
    )
    anonymous_request = AgentRequest(
        message="synthetic message",
        user_id="owner-1",
        user_name="合成用户",
        source="telegram",
        chat_id="-1007002",
        platform_bot_id="41",
        actor_context=anonymous_actor,
    )
    unbound_private = await resolve_access(
        "telegram", "c2c", "41", "owner-1", "7002"
    )
    verified_private = await resolve_access(
        "telegram", "c2c", "41", "owner-1", "7001"
    )
    named_group_member = await resolve_access(
        "telegram", "group", "41", "owner-1", "7002"
    )

    assert anonymous_actor.is_im is True
    assert anonymous_actor.role == "unknown"
    assert policy_for(anonymous_request).restricted is True
    assert policy_for(anonymous_request).load_owner_context is False
    assert unbound_private.role == "unknown"
    assert verified_private.role == "owner"
    assert named_group_member.role == "member"
