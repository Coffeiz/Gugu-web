"""保护群聊自动回复：回复门关闭期间群里不得出现任何可见内容。

这条不变量来自 PRD-IM-16 §6——错误终态（模型失败、超时、无效协议）必须保留
真实错误与受限诊断，但不能被当成回复发进群，否则群成员会看到本轮本不该出现的
提示；门打开之后的失败仍然要送达，否则用户不知道该重试。
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent.im import dispatch_finalization
from agent.im.auto_reply import ReplyGate
from agent.models import AgentResponse


@pytest.fixture
def platform_sender(monkeypatch):
    from agent.gateway import qq

    group_send = AsyncMock(return_value=True)
    private_send = AsyncMock(return_value=True)
    monkeypatch.setattr(qq, "send_group", group_send)
    monkeypatch.setattr(qq, "send_c2c", private_send)
    monkeypatch.setattr(
        "agent.im.files.send_files",
        AsyncMock(return_value=SimpleNamespace(failed=False)),
    )
    monkeypatch.setattr(dispatch_finalization, "persist_im_session", AsyncMock())
    monkeypatch.setattr(
        dispatch_finalization, "_should_observe_private_member_activity", lambda _: False
    )
    monkeypatch.setattr(dispatch_finalization, "finalize_im_response", AsyncMock())
    finish = Mock()
    monkeypatch.setattr(dispatch_finalization.trace, "finish_run", finish)
    return group_send, private_send, finish


async def finalize(response, *, chat_type="group", group_auto_reply=True, gate=None):
    request = SimpleNamespace(
        source="qq",
        platform_user_id="synthetic-user",
        chat_id="synthetic-group" if chat_type == "group" else None,
        group_auto_reply=group_auto_reply,
        group_reply_gate=gate,
    )
    payload = {
        "platform": "qq",
        "chat_type": chat_type,
        "chat_id": "synthetic-group" if chat_type == "group" else None,
        "platform_user_id": "synthetic-user",
        "channel_id": "synthetic-bot",
        "message_id": "synthetic-inbound",
    }
    return await dispatch_finalization.finalize_im_dispatch(
        payload=payload,
        request=request,
        route=SimpleNamespace(bot_id="synthetic-bot"),
        session_scope="synthetic",
        response=response,
        trace_id="synthetic-trace",
        sent_round_indices=set(),
        shown_interaction_ids=set(),
        show_intermediate_replies=True,
        stream_sent=False,
        stream_reply_text="",
    )


@pytest.mark.asyncio
async def test_protocol_failure_keeps_group_silent(platform_sender):
    """无效协议是错误终态，但回复门没开时群里一个字都不能有。"""
    group_send, private_send, finish = platform_sender
    response = AgentResponse(text="合成失败提示", errored=True)

    await finalize(response, gate=ReplyGate())

    group_send.assert_not_awaited()
    private_send.assert_not_awaited()
    assert finish.call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_model_failure_keeps_group_silent(platform_sender):
    """模型失败/超时同样不能把错误文案当回复发进群。"""
    group_send, _private_send, finish = platform_sender
    response = AgentResponse(text="合成模型失败提示", errored=True)

    await finalize(response, gate=ReplyGate())

    group_send.assert_not_awaited()
    assert finish.call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_unselected_run_keeps_group_silent(platform_sender):
    """模型没做选择就结束时，群里的可见输出必须为零。"""
    group_send, _private_send, finish = platform_sender
    response = AgentResponse(text="模型直接输出的正文")

    await finalize(response, gate=ReplyGate())

    group_send.assert_not_awaited()
    assert finish.call_args.args[0] == "success"


@pytest.mark.asyncio
async def test_error_after_reply_selection_is_still_delivered(platform_sender):
    """门已经打开时失败要送达，否则群成员等不到任何回应。"""
    group_send, _private_send, finish = platform_sender
    gate = ReplyGate()
    gate.choose(True)
    response = AgentResponse(text="合成失败提示", errored=True)

    await finalize(response, gate=gate)

    group_send.assert_awaited_once()
    assert group_send.await_args.args[1] == "合成失败提示"
    assert finish.call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_private_chat_error_is_not_suppressed(platform_sender):
    """私聊不受群聊静默门影响，失败提示照常送达。"""
    _group_send, private_send, finish = platform_sender
    response = AgentResponse(text="合成模型失败提示", errored=True)

    await finalize(response, chat_type="c2c", group_auto_reply=False, gate=None)

    private_send.assert_awaited_once()
    assert private_send.await_args.args[1] == "合成模型失败提示"
    assert finish.call_args.args[0] == "error"
