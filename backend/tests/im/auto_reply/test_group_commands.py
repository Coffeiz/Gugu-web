"""群聊里的斜杠命令必须确证是对咕咕说的才生效。

规则来自 PRD-IM-16 §2 与本轮统一：群里命令必须有 @ 咕咕（QQ/飞书没有 bot
作用域，裸打 ``/命令`` 判断不出是给谁的）；Telegram 的 ``group_mentioned``
已包含命令触发，天然满足。私聊一律免 @。

另外 owner 私有结果（记忆画像、工作区清单）在群里不能贴群，必须私发 owner。
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.im.dispatch import dispatch_im_message


def _group_payload(text, *, requires_at=False, read_enabled=False, mentioned=False):
    return {
        "platform": "qq",
        "chat_type": "group",
        "channel_id": "bot-id",
        "chat_id": "group-id",
        "platform_user_id": "owner-id",
        "owner_user_id": "owner-id",
        "text": text,
        "message_id": "message-id",
        "group_requires_at": requires_at,
        "group_read_enabled": read_enabled,
        "group_mentioned": mentioned,
    }


def _setup(monkeypatch, user_a, text, *, requires_at=False, read_enabled=False,
           mentioned=False, role="owner", command_reply="命令已执行"):
    """把 dispatch 的外部依赖换成可控桩，记录命令调用、群内出站和 Agent 入口。"""
    state = {
        "commands": [], "sent": [], "ran_agent": False,
        "private_deliveries": [], "prewarm": [],
    }

    request = SimpleNamespace(
        user_id=str(user_a.id),
        source="qq",
        message=text,
        session_id=17,
        chat_id="group-id",
        platform_user_id="owner-id",
        attachments=[],
        im_role=role,
    )
    prepared = SimpleNamespace(
        request=request,
        actor=SimpleNamespace(platform="qq", platform_user_id="owner-id"),
        session_route=SimpleNamespace(scope_id="group-id", bot_id="bot-id", is_group=True),
        session_id=17,
    )
    state["request"] = request

    async def fake_command(_user_id, message, *_args, **_kwargs):
        state["commands"].append(message)
        return command_reply

    async def fake_send(_payload, message):
        state["sent"].append(message)

    async def fake_deliver_private(user_id, message, platform):
        state["private_deliveries"].append((str(user_id), message, platform))
        return True

    async def fake_run_collect(*_args, **_kwargs):
        state["ran_agent"] = True
        return SimpleNamespace(errored=False, text="", session_id=17, files=[])

    monkeypatch.setattr(
        "agent.im.dispatch.resolve_group_policy",
        AsyncMock(return_value=(True, requires_at, read_enabled, True, True)),
    )
    monkeypatch.setattr(
        "agent.gateway.qq.client.schedule_qq_outbound_prewarm",
        lambda channel_id: state["prewarm"].append(channel_id),
    )
    monkeypatch.setattr("agent.im.dispatch.prepare_message", AsyncMock(return_value=prepared))
    monkeypatch.setattr(
        "agent.im.dispatch.decide_im_shortcut", AsyncMock(return_value={"action": "continue"}),
    )
    monkeypatch.setattr("agent.im.dispatch.handle_im_command", fake_command)
    monkeypatch.setattr("agent.im.dispatch.record_passive_im_message", AsyncMock(return_value=17))
    monkeypatch.setattr("agent.im.dispatch.persist_im_session", AsyncMock(return_value=None))
    monkeypatch.setattr("agent.im.replies.send_text", fake_send)
    monkeypatch.setattr(
        "agent.im.interaction_text.consume_mcp_secret_payload", AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "agent.im.interaction_text.consume_text_choice", AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "agent.im.session.get_or_create_session",
        AsyncMock(return_value=SimpleNamespace(session=SimpleNamespace(id=17))),
    )
    monkeypatch.setattr("agent.runtime.trace.set_trace", lambda *_a: None)
    monkeypatch.setattr("agent.runtime.trace.bind_im_run", lambda *_a: None)
    monkeypatch.setattr("agent.runtime.trace.finish_run", lambda *_a, **_k: None)
    monkeypatch.setattr("agent.runtime.trace.discard_run", lambda *_a: None)
    # 命令未生效时消息继续走普通群聊链路，这里只需要它不要真的跑模型。
    monkeypatch.setattr("agent.runner.run_collect", fake_run_collect)
    monkeypatch.setattr("agent.im.dispatch.finalize_im_dispatch", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "agent.im.dispatch._im_display_preferences", AsyncMock(return_value=("off", False)),
    )
    monkeypatch.setattr("agent.im.dispatch.bind_im_context", lambda *_a, **_k: None)
    monkeypatch.setattr("agent.im.dispatch.remember_im_reach", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "agent.im.dispatch.start_im_activity", AsyncMock(return_value=SimpleNamespace()),
    )
    monkeypatch.setattr(
        "agent.im.dispatch.finish_im_activity", AsyncMock(return_value=None),
    )
    monkeypatch.setattr("agent.im.dispatch._ensure_im_session", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.scheduled_tasks.deliver_owner_private", fake_deliver_private,
    )
    from agent.llm import genstream

    monkeypatch.setattr(genstream, "begin", AsyncMock(return_value=None))
    monkeypatch.setattr(genstream, "publish", AsyncMock(return_value=None))
    monkeypatch.setattr(genstream, "end", AsyncMock(return_value=None))
    return state


@pytest.mark.asyncio
async def test_group_command_without_mention_is_not_treated_as_command(monkeypatch, user_a):
    """自动回复模式：群里裸打命令不执行，按普通群消息继续走回复选择门。"""
    state = _setup(monkeypatch, user_a, "/help")

    await dispatch_im_message(_group_payload("/help"))

    assert state["commands"] == []
    assert state["sent"] == []
    # 没有当成命令 → 回复门仍然待命，消息按普通群消息进模型。
    assert state["request"].group_auto_reply is True
    assert state["ran_agent"] is True
    assert state["prewarm"] == ["bot-id"]


@pytest.mark.asyncio
async def test_group_command_with_mention_is_executed(monkeypatch, user_a):
    """群里 @ 咕咕后命令照常生效，回复进群且不进回复选择门。"""
    state = _setup(monkeypatch, user_a, "<@bot-id> /help", mentioned=True)

    await dispatch_im_message(_group_payload("<@bot-id> /help", mentioned=True))

    # IM 层剥掉 mention 前缀后才交给命令层解析。
    assert state["commands"] == ["/help"]
    assert state["sent"] == ["命令已执行"]
    assert state["ran_agent"] is False
    assert state["request"].group_auto_reply is False


@pytest.mark.asyncio
async def test_destructive_command_without_mention_is_not_executed(monkeypatch, user_a):
    """群里裸打 /new 不能清会话：没有 @ 就不算命令。"""
    state = _setup(monkeypatch, user_a, "/new")

    await dispatch_im_message(_group_payload("/new"))

    assert state["commands"] == []
    assert state["sent"] == []


@pytest.mark.asyncio
async def test_private_command_with_mention_is_denied_for_non_owner(monkeypatch, user_a):
    """群成员 @ 咕咕后打私有命令：拿到权限提示，命令处理器不被调用。"""
    state = _setup(monkeypatch, user_a, "/new", mentioned=True, role="member")

    await dispatch_im_message(_group_payload("/new", mentioned=True))

    assert state["commands"] == []
    assert len(state["sent"]) == 1
    assert "只有绑定 Bot 的用户" in state["sent"][0]


@pytest.mark.asyncio
async def test_private_result_is_delivered_to_owner_instead_of_group(monkeypatch, user_a):
    """owner 私有结果不能贴群：改私发 owner，群里只回一句提示。"""
    memory_text = "这是我目前记得的关于你的事：· 你喜欢猫"
    state = _setup(monkeypatch, user_a, "/memory", mentioned=True, command_reply=memory_text)

    await dispatch_im_message(_group_payload("/memory", mentioned=True))

    assert state["private_deliveries"] == [
        (str(user_a.id), memory_text, "qq"),
    ]
    assert len(state["sent"]) == 1
    assert memory_text not in state["sent"][0]


@pytest.mark.asyncio
async def test_private_result_falls_back_to_group_notice_when_private_send_fails(
    monkeypatch, user_a,
):
    """私发失败时群里只提示去私聊，不能退回贴原文。"""
    memory_text = "这是我目前记得的关于你的事：· 你喜欢猫"
    state = _setup(monkeypatch, user_a, "/memory", mentioned=True, command_reply=memory_text)

    async def failing_deliver(*_args, **_kwargs):
        return False

    monkeypatch.setattr("app.scheduled_tasks.deliver_owner_private", failing_deliver)

    await dispatch_im_message(_group_payload("/memory", mentioned=True))

    assert len(state["sent"]) == 1
    assert memory_text not in state["sent"][0]
    assert "私聊" in state["sent"][0]


@pytest.mark.asyncio
async def test_command_works_without_mention_in_private_chat(monkeypatch, user_a):
    """私聊不受 @ 限制。"""
    state = _setup(monkeypatch, user_a, "/help")

    await dispatch_im_message({
        "platform": "qq",
        "chat_type": "c2c",
        "channel_id": "bot-id",
        "chat_id": "owner-id",
        "platform_user_id": "owner-id",
        "owner_user_id": "owner-id",
        "text": "/help",
        "message_id": "message-id",
    })

    assert state["commands"] == ["/help"]
    assert state["sent"] == ["命令已执行"]


@pytest.mark.asyncio
async def test_command_needs_mention_in_mentions_only_mode(monkeypatch, user_a):
    """仅 @ 模式：非 @ 消息在被动分流处就返回，命令不生效。"""
    state = _setup(monkeypatch, user_a, "/help", requires_at=True)

    await dispatch_im_message(_group_payload("/help", requires_at=True))

    assert state["commands"] == []
    assert state["sent"] == []


@pytest.mark.asyncio
async def test_command_needs_mention_in_record_only_mode(monkeypatch, user_a):
    """静默记录模式：所有群消息只落库，命令同样不生效。"""
    state = _setup(monkeypatch, user_a, "/help", read_enabled=True)

    await dispatch_im_message(_group_payload("/help", read_enabled=True))

    assert state["commands"] == []
    assert state["sent"] == []
