from app.models import UserBot
from app.services.im_identity import resolve_qq_group_access


async def test_qq_group_owner_gets_full_tool_set(db, user_a):
    bot = UserBot(
        user_id=user_a.id,
        platform="qq",
        app_id="app-1",
        app_secret="secret",
        owner_platform_user_id="owner-1",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    access = await resolve_qq_group_access(db, bot.id, user_a.id, "owner-1")

    assert access.role == "owner"
    assert access.allowed_tool_names is None


async def test_qq_group_member_only_gets_configured_allowlist(db, user_a):
    bot = UserBot(
        user_id=user_a.id,
        platform="qq",
        app_id="app-1",
        app_secret="secret",
        owner_platform_user_id="owner-1",
        group_allowed_tools=["web_search"],
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    access = await resolve_qq_group_access(db, bot.id, user_a.id, "member-1")

    assert access.role == "member"
    assert access.allowed_tool_names == ["web_search"]


async def test_qq_group_unknown_uses_minimum_allowlist(db, user_a):
    bot = UserBot(
        user_id=user_a.id,
        platform="qq",
        app_id="app-1",
        app_secret="secret",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    access = await resolve_qq_group_access(db, bot.id, user_a.id, "member-1")

    assert access.role == "unknown"
    assert access.allowed_tool_names == ["web_search", "image_search"]


async def test_group_context_search_only_reads_current_group(db, user_a, monkeypatch):
    from agent import imctx
    from agent.tools.group_context import _group_context_search
    from app.models import ConversationMessage, ConversationSession

    current = ConversationSession(user_id=user_a.id, source="qq", bot_id="bot-1", chat_id="group-a", title="群 A")
    other = ConversationSession(user_id=user_a.id, source="qq", bot_id="bot-1", chat_id="group-b", title="群 B")
    db.add_all([current, other])
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=current.id, role="user", content="群 A 的消息"),
        ConversationMessage(session_id=other.id, role="user", content="群 B 的消息"),
    ])
    await db.commit()
    imctx.set_im("qq", "m1", "bot-1", "group-a", "member", "group")

    result = await _group_context_search(db, user_a.id, {})

    assert [row["content"] for row in result["messages"]] == ["群 A 的消息"]
    imctx.clear()


async def test_group_context_search_accepts_multiple_keywords(db, user_a, monkeypatch):
    from agent import imctx
    from agent.tools.group_context import _group_context_search
    from app.models import ConversationMessage, ConversationSession

    current = ConversationSession(user_id=user_a.id, source="qq", bot_id="bot-1", chat_id="group-a", title="群 A")
    db.add(current)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=current.id, role="user", content="部署方案"),
        ConversationMessage(session_id=current.id, role="user", content="上线清单"),
    ])
    await db.commit()
    imctx.set_im("qq", "m1", "bot-1", "group-a", "member", "group")

    result = await _group_context_search(db, user_a.id, {"queries": ["部署", "上线"]})

    assert [row["content"] for row in result["messages"]] == ["部署方案", "上线清单"]
    assert result["mode"] == "OR"
    imctx.clear()


def test_im_identity_context_is_not_injected_into_webchat():
    from agent.models import AgentRequest
    from agent.runner import _im_identity_block

    request = AgentRequest(message="你好", user_id="u1", user_name="coffeiz")

    assert _im_identity_block(request, []) == ""


def test_member_context_policy_does_not_load_owner_context():
    from agent.im.context_policy import policy_for
    from agent.models import AgentRequest

    policy = policy_for(AgentRequest(
        message="你好",
        user_id="u1",
        user_name="群友",
        source="qq",
        platform_user_id="member-1",
        im_role="member",
    ))

    assert policy.restricted is True
    assert policy.load_owner_context is False
    assert policy.allow_continuity_bridge is False
    assert policy.allow_memory_reflection is False


def test_web_context_policy_keeps_full_context():
    from agent.im.context_policy import policy_for
    from agent.models import AgentRequest

    policy = policy_for(AgentRequest(message="你好", user_id="u1", user_name="coffeiz"))

    assert policy.is_im is False
    assert policy.load_owner_context is True


def test_tool_permission_filter_and_dispatch_gate_share_the_same_rule():
    from agent.im.permissions import can_use_tool, filter_tool_names

    assert filter_tool_names(["projects", "web_search", "files"], ["web_search", "missing"]) == ["web_search"]
    assert can_use_tool("web_search", ["web_search"]) is True
    assert can_use_tool("files", ["web_search"]) is False
    assert can_use_tool("files", None) is True


def test_member_display_name_does_not_use_owner_account_name():
    from agent.im.identity import ImIdentity, display_name_for_message

    identity = ImIdentity("owner", "coffeiz")

    assert display_name_for_message(identity, {"platform_user_name": "群友 A"}, "member") == "群友 A"
    assert display_name_for_message(identity, {}, "unknown") == "这位群友"
    assert display_name_for_message(identity, {}, "owner") == "coffeiz"


def test_actor_context_keeps_owner_and_platform_identity_separate():
    from agent.im.actor import ActorContext

    actor = ActorContext(
        owner_user_id="gugu-user",
        platform="qq",
        platform_user_id="qq-member",
        role="member",
        chat_type="group",
        chat_id="group-1",
        allowed_tool_names=["web_search"],
    )

    assert actor.owner_user_id != actor.platform_user_id
    assert actor.is_im is True
    assert actor.is_owner is False
    assert actor.is_restricted is True


async def test_im_loop_prepares_actor_and_agent_request(monkeypatch):
    from agent.im.loop import prepare_request
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender

    async def fake_access(*args, **kwargs):
        from agent.im.permissions import ImAccess
        return ImAccess("member", ["web_search"])

    monkeypatch.setattr("agent.im.loop.resolve_access", fake_access)
    message = PlatformMessage(
        platform="qq",
        bot_id="bot-1",
        message_id="message-1",
        chat=ChatTarget("group-1", "group"),
        sender=PlatformSender("member-1", "群友"),
        content="你好",
    )

    prepared = await prepare_request(message, {"chat_type": "group", "chat_id": "group-1"}, "owner", "群友")

    assert prepared.actor.owner_user_id == "owner"
    assert prepared.actor.platform_user_id == "member-1"
    assert prepared.request.actor_context is prepared.actor
    assert prepared.request.im_role == "member"


async def test_non_qq_group_defaults_to_unknown_minimal_access(monkeypatch):
    from agent.im.loop import prepare_request
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender

    message = PlatformMessage(
        platform="wechat",
        bot_id="bot-1",
        message_id="message-1",
        chat=ChatTarget("wx-group-1", "group"),
        sender=PlatformSender("member-1", "群友"),
        content="你好",
    )

    prepared = await prepare_request(
        message,
        {"chat_type": "group", "chat_id": "wx-group-1", "wechat_group_id": "wx-group-1"},
        "owner",
        "coffeiz",
    )

    assert prepared.actor.role == "unknown"
    assert prepared.request.im_role == "unknown"
    assert prepared.request.allowed_tool_names == ["web_search", "image_search"]
    assert prepared.request.user_name == "群友"
    assert prepared.request.chat_id == "wx-group-1"


async def test_feishu_group_uses_bound_owner_open_id(db, user_a):
    from agent.im.loop import prepare_request
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender
    from app.models import UserBot

    bot = UserBot(
        user_id=user_a.id,
        platform="feishu",
        app_id="feishu-app",
        app_secret="secret",
        owner_platform_user_id="ou-owner",
        group_allowed_tools=["web_search"],
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)

    owner_message = PlatformMessage(
        platform="feishu",
        bot_id=str(bot.id),
        message_id="m-owner",
        chat=ChatTarget("oc-group", "group"),
        sender=PlatformSender("ou-owner", "本人"),
        content="看项目",
    )
    member_message = PlatformMessage(
        platform="feishu",
        bot_id=str(bot.id),
        message_id="m-member",
        chat=ChatTarget("oc-group", "group"),
        sender=PlatformSender("ou-member", "群友"),
        content="你好",
    )

    owner = await prepare_request(owner_message, {"chat_type": "group", "channel_id": str(bot.id)}, user_a.id, "本人")
    member = await prepare_request(member_message, {"chat_type": "group", "channel_id": str(bot.id)}, user_a.id, "本人")

    assert owner.request.im_role == "owner"
    assert owner.request.allowed_tool_names is None
    assert member.request.im_role == "member"
    assert member.request.allowed_tool_names == ["web_search"]


async def test_non_qq_private_message_keeps_owner_access():
    from agent.im.loop import prepare_request
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender

    message = PlatformMessage(
        platform="wechat",
        bot_id="bot-1",
        message_id="message-1",
        chat=ChatTarget("owner-platform-id", "c2c"),
        sender=PlatformSender("owner-platform-id", "coffeiz"),
        content="看看项目",
    )

    prepared = await prepare_request(message, {"chat_type": "c2c"}, "owner", "coffeiz")

    assert prepared.actor.role == "owner"
    assert prepared.request.im_role == "owner"
    assert prepared.request.allowed_tool_names is None


async def test_feishu_private_message_keeps_owner_access():
    from agent.im.loop import prepare_request
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender

    message = PlatformMessage(
        platform="feishu",
        bot_id="bot-1",
        message_id="message-1",
        chat=ChatTarget("oc-private-1", "c2c"),
        sender=PlatformSender("ou-owner-1", "coffeiz"),
        content="看看我的文件",
    )

    prepared = await prepare_request(message, {"chat_type": "c2c"}, "owner", "coffeiz")

    assert prepared.actor.role == "owner"
    assert prepared.request.im_role == "owner"
    assert prepared.request.allowed_tool_names is None


def test_group_history_keeps_sender_id_and_name_in_model_context():
    from types import SimpleNamespace

    from agent.im.context_loader import format_history_content
    from agent.models import AgentRequest

    request = AgentRequest(
        message="现在呢",
        user_id="owner",
        user_name="coffeiz",
        source="qq",
        chat_id="group-1",
    )
    message = SimpleNamespace(
        role="user",
        content="看看项目",
        chat_type="group",
        platform_user_id="member-2",
        platform_user_name="CoffeiZzz",
    )

    formatted = format_history_content(message, request)

    assert "发言人ID=member-2" in formatted
    assert "显示名=CoffeiZzz" in formatted
    assert formatted.endswith("看看项目")


def test_current_group_message_has_priority_sender_anchor():
    from agent.im.context_loader import format_current_content
    from agent.models import AgentRequest

    request = AgentRequest(
        message="我喜欢什么",
        user_id="owner",
        user_name="coffeiz",
        source="qq",
        chat_id="group-1",
        platform_user_id="owner-1",
        platform_user_name="Coffeiz",
        im_role="owner",
    )

    formatted = format_current_content(request.message, request)

    assert formatted.startswith("[当前群聊发言人，优先级高于历史消息]")
    assert "平台身份=owner-1" in formatted
    assert "群昵称=Coffeiz" in formatted
    assert "权限角色=绑定用户 owner" in formatted
    assert formatted.endswith("我喜欢什么")


def test_session_route_uses_group_id_for_group_and_sender_id_for_private_chat():
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender
    from agent.im.session import resolve_route

    group = PlatformMessage(
        platform="qq", bot_id="bot", message_id="m1",
        chat=ChatTarget("group-1", "group"), sender=PlatformSender("member-1"),
    )
    private = PlatformMessage(
        platform="qq", bot_id="bot", message_id="m2",
        chat=ChatTarget("member-1", "c2c"), sender=PlatformSender("member-1"),
    )

    assert resolve_route(group, {}).scope_id == "group-1"
    assert resolve_route(group, {}).is_group is True
    assert resolve_route(private, {}).scope_id == "member-1"
    assert resolve_route(private, {}).is_group is False


def test_im_session_scope_filters_isolate_group_and_private_sessions():
    from agent.im.session import session_scope_filters

    # 用真实 SQLAlchemy 模型验证会生成两条归属条件，不在这里执行 SQL。
    from app.models import ConversationSession

    group_filters = session_scope_filters(ConversationSession, "qq", "group-1")
    private_filters = session_scope_filters(ConversationSession, "qq", None, platform_user_id="sender-1")
    # 群聊：source + bot_id + chat_id = 3 条
    assert len(group_filters) == 3
    # 私聊：source + bot_id + chat_id IS NULL + platform_user_id = 4 条
    assert len(private_filters) == 4
    assert "chat_id IS NULL" in str(private_filters[2])
    assert "platform_user_id" in str(private_filters[3])


def test_im_session_scope_filters_private_missing_puid_fails_closed():
    """P1-2 fail closed：私聊缺 platform_user_id 时返回空过滤（不参与复用），
    由上游 get_or_create_session / _persist_push_im 在调用方拒绝进入 Agent。
    绝不允许退化成"同 user 同平台所有私聊串一起"。
    """
    from agent.im.session import session_scope_filters
    from app.models import ConversationSession

    # 缺 platform_user_id（私聊）→ 空过滤（不参与复用）
    filters = session_scope_filters(ConversationSession, "qq", None)
    assert filters == []

    # 显式传 None 也算缺
    filters = session_scope_filters(ConversationSession, "qq", None, platform_user_id=None)
    assert filters == []

    # 群聊不受影响：有 chat_id 时正常返回 3 条
    filters = session_scope_filters(ConversationSession, "qq", "group-1")
    assert len(filters) == 3

    # web 源：返回空（不参与 IM 作用域复用）
    filters = session_scope_filters(ConversationSession, "web", None, platform_user_id="sender-1")
    assert filters == []


def test_im_session_scope_filters_include_bot_id():
    from agent.im.session import session_scope_filters
    from app.models import ConversationSession

    filters = session_scope_filters(ConversationSession, "qq", "group-1", "bot-a")
    assert "conversation_sessions.bot_id = :bot_id_1" in str(filters[1])


async def test_im_sessions_are_isolated_by_bot_id(db, user_a):
    from agent.im.session import get_or_create_session
    from agent.models import AgentRequest

    first = await get_or_create_session(
        db,
        AgentRequest(
            message="bot A",
            user_id=user_a.id,
            user_name="群友",
            source="qq",
            platform_bot_id="bot-a",
            chat_id="group-1",
        ),
        user_a.id,
    )
    second = await get_or_create_session(
        db,
        AgentRequest(
            message="bot B",
            user_id=user_a.id,
            user_name="群友",
            source="qq",
            platform_bot_id="bot-b",
            chat_id="group-1",
        ),
        user_a.id,
    )

    assert first.session.id != second.session.id
    assert first.session.bot_id == "bot-a"
    assert second.session.bot_id == "bot-b"


def test_im_loop_selects_member_or_owner_facade_without_duplicate_runtime():
    from agent.im.actor import ActorContext
    from agent.im.loop import MemberAgentLoop, OwnerAgentLoop, select_loop
    from agent.models import AgentRequest

    member = AgentRequest(
        message="你好", user_id="owner", user_name="群友", source="qq",
        actor_context=ActorContext("owner", "qq", role="member"),
    )
    owner = AgentRequest(
        message="你好", user_id="owner", user_name="coffeiz", source="qq",
        actor_context=ActorContext("owner", "qq", role="owner"),
    )

    assert isinstance(select_loop(member), MemberAgentLoop)
    assert isinstance(select_loop(owner), OwnerAgentLoop)
    assert type(select_loop(member).run_collect) is type(select_loop(owner).run_collect)


async def test_worker_handle_delegates_business_dispatch_to_im_loop(monkeypatch):
    import worker

    seen = []

    async def fake_dispatch(payload):
        seen.append(payload)
        return "done"

    monkeypatch.setattr("agent.im.loop.dispatch_im_message", fake_dispatch)
    assert await worker.handle("msg-1", {"text": "你好"}) == "done"
    assert seen == [{"text": "你好"}]


def test_im_identity_context_marks_group_and_compares_history():
    from types import SimpleNamespace

    from agent.models import AgentRequest
    from agent.runner import _im_identity_block

    request = AgentRequest(
        message="我是谁",
        user_id="u1",
        user_name="coffeiz",
        source="qq",
        chat_id="group-a",
        platform_user_id="member-a",
        im_role="member",
    )
    block = _im_identity_block(request, [SimpleNamespace(role="user", platform_user_id="member-a")])

    assert "会话类型：群聊" in block
    assert "当前权限角色：群成员" in block
    assert "member-a" in block
