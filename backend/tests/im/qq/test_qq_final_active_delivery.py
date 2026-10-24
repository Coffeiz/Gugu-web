"""QQ 私聊正文实时流送达；最终收尾不重复发送，异常仍走普通回复出口。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent.im import dispatch_finalization, replies
from agent.models import AgentResponse


@pytest.fixture
def delivery(monkeypatch):
    from agent.gateway import qq

    passive_send = AsyncMock(return_value=True)
    streamed = []

    class FakeStream:
        def __init__(self):
            self.text = ""

        def push(self, text):
            self.text += text

        async def finish(self, text):
            streamed.append(text)

        def has_sent(self):
            return bool(self.text)

    monkeypatch.setattr(qq, "send_c2c", passive_send)
    monkeypatch.setattr(qq, "send_group", passive_send)
    monkeypatch.setattr(qq, "create_private_text_stream", Mock(side_effect=lambda *_args, **_kwargs: FakeStream()))
    monkeypatch.setattr("agent.im.files.send_files", AsyncMock(return_value=SimpleNamespace(failed=False)))
    monkeypatch.setattr(dispatch_finalization, "persist_im_session", AsyncMock())
    monkeypatch.setattr(dispatch_finalization, "_should_observe_private_member_activity", lambda _: False)
    monkeypatch.setattr(dispatch_finalization, "finalize_im_response", AsyncMock())
    finish = Mock()
    monkeypatch.setattr(dispatch_finalization.trace, "finish_run", finish)
    return passive_send, finish, streamed


async def finalize(payload, response, *, stream_sent=False, stream_reply_text=""):
    request = SimpleNamespace(source="qq", platform_user_id="synthetic-user", chat_id=None)
    return await dispatch_finalization.finalize_im_dispatch(
        payload=payload, request=request, route=SimpleNamespace(bot_id="synthetic-bot"),
        session_scope="synthetic", response=response, trace_id="synthetic-trace",
        sent_round_indices={0}, shown_interaction_ids=set(), show_intermediate_replies=True,
        stream_sent=stream_sent, stream_reply_text=stream_reply_text,
    )


@pytest.mark.asyncio
async def test_private_final_is_streamed_with_inbound_id_and_not_sent_again(delivery, monkeypatch):
    from agent.gateway import qq

    passive_send, finish, streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}
    response = AgentResponse(text="最终结论")
    create_stream = qq.create_private_text_stream
    created = []

    def make_stream(*args, **kwargs):
        created.append(kwargs)
        return create_stream(*args, **kwargs)

    monkeypatch.setattr(qq, "create_private_text_stream", make_stream)

    async def events():
        yield "token", "最终结论"
        yield "final", response

    stream_sent, result, reply_text = await replies.send_qq_stream_by_round(
        payload, events(), show_intermediate_replies=True,
    )
    await finalize(payload, result, stream_sent=stream_sent, stream_reply_text=reply_text)

    assert stream_sent is True
    assert streamed == ["最终结论"]
    assert created[0]["message_id"] == "synthetic-inbound"
    passive_send.assert_not_awaited()
    assert finish.call_args.args[0] == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback_succeeds", [True, False])
async def test_stream_without_inbound_id_uses_reply_fallback_and_only_skips_after_success(
    delivery, monkeypatch, fallback_succeeds,
):
    passive_send, finish, _streamed = delivery
    fallback_send = AsyncMock(return_value=fallback_succeeds)
    monkeypatch.setattr(replies, "send_text", fallback_send)
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot"}
    response = AgentResponse(text="最终结论")

    async def events():
        yield "token", "最终结论"
        yield "final", response

    stream_sent, result, reply_text = await replies.send_qq_stream_by_round(
        payload, events(), show_intermediate_replies=True,
    )
    await finalize(payload, result, stream_sent=stream_sent, stream_reply_text=reply_text)

    assert fallback_send.await_count == (1 if fallback_succeeds else 2)
    assert all(call.args == (payload, "最终结论") for call in fallback_send.await_args_list)
    assert passive_send.await_count == 0
    assert finish.call_args.args[0] == ("success" if fallback_succeeds else "error")


@pytest.mark.asyncio
async def test_c2c_error_notice_still_uses_ordinary_reply_after_stream(delivery):
    passive_send, finish, _streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}
    await finalize(payload, AgentResponse(text="最终错误提示", errored=True), stream_sent=True)
    passive_send.assert_awaited_once()
    assert passive_send.await_args.args[1] == "最终错误提示"
    assert passive_send.await_args.args[2] == "synthetic-inbound"
    assert finish.call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_unstreamed_final_uses_passive_reply_and_reports_delivery_failure(delivery):
    passive_send, finish, _streamed = delivery
    passive_send.return_value = False
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-expired"}
    await finalize(payload, AgentResponse(text="最终结论"))
    passive_send.assert_awaited_once()
    assert passive_send.await_args.args[2] == "synthetic-expired"
    assert finish.call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_cancelled_run_does_not_send_final(delivery):
    passive_send, finish, _streamed = delivery
    await finalize({"platform": "qq"}, AgentResponse(text="未完成正文", cancelled=True))
    passive_send.assert_not_awaited()
    assert finish.call_args.args[0] == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("errored", [True, False])
async def test_group_final_uses_ordinary_reply_without_private_streaming(delivery, errored):
    passive_send, finish, _streamed = delivery
    payload = {"platform": "qq", "chat_type": "group", "chat_id": "synthetic-group",
               "platform_user_id": "synthetic-user", "channel_id": "synthetic-bot",
               "message_id": "synthetic-inbound"}
    await finalize(payload, AgentResponse(text="最终提示", round_texts=["过程说明"], errored=errored),
                   stream_sent=True)
    passive_send.assert_awaited_once()
    assert passive_send.await_args.args[0] == "synthetic-group"
    assert passive_send.await_args.args[1] == "最终提示"
    assert passive_send.await_args.args[2] == "synthetic-inbound"
    assert finish.call_args.args[0] == ("error" if errored else "success")
