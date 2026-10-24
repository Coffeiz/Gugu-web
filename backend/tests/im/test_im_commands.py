"""IM 斜杠命令必须在读取/修改 Owner 状态前校验发言人角色。"""

from types import SimpleNamespace

import pytest

from agent.im.dispatch import dispatch_im_message


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["member", "unknown", None])
async def test_non_owner_im_command_is_rejected_before_command_handler(monkeypatch, role):
    sent = []
    req = SimpleNamespace(
        user_id="owner-id",
        source="qq",
        message="/auto on",
        session_id=17,
        chat_id=None,
        platform_user_id="member-id",
        attachments=[],
        im_role=role,
    )
    prepared = SimpleNamespace(
        request=req,
        actor=SimpleNamespace(platform="qq", platform_user_id="member-id"),
        session_route=SimpleNamespace(scope_id="private-id", bot_id="bot-id", is_group=False),
        session_id=17,
    )

    async def fake_async(*_args, **_kwargs):
        return None

    async def fake_send(_payload, message):
        sent.append(message)

    async def fake_prepare(*_args, **_kwargs):
        return prepared

    async def fake_shortcut(*_args, **_kwargs):
        return {"action": "continue"}

    monkeypatch.setattr("agent.im.interaction_text.consume_mcp_secret_payload", fake_async)
    monkeypatch.setattr("agent.im.interaction_text.consume_text_choice", fake_async)
    monkeypatch.setattr("agent.im.dispatch.prepare_message", fake_prepare)
    monkeypatch.setattr("agent.im.dispatch.decide_im_shortcut", fake_shortcut)
    monkeypatch.setattr("agent.im.replies.send_text", fake_send)
    monkeypatch.setattr("agent.runtime.trace.set_trace", lambda *_args: None)
    monkeypatch.setattr("agent.runtime.trace.bind_im_run", lambda *_args: None)
    monkeypatch.setattr("agent.runtime.trace.finish_run", lambda *_args: None)

    async def unexpected_command(*_args, **_kwargs):
        raise AssertionError("权限拒绝前不应进入命令处理器")

    monkeypatch.setattr("agent.im.dispatch.handle_im_command", unexpected_command)

    await dispatch_im_message({
        "platform": "qq",
        "chat_type": "private",
        "channel_id": "bot-id",
        "chat_id": "private-id",
        "platform_user_id": "member-id",
        "owner_user_id": "owner-id",
        "text": "/auto on",
        "message_id": "message-id",
    })

    assert len(sent) == 1
    assert "只有绑定 Bot 的用户" in sent[0]
