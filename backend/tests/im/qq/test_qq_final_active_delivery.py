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

        async def finish(self, text, *, allow_rewrite=False):
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
async def test_private_final_is_streamed_and_not_sent_again(delivery, monkeypatch):
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
async def test_next_round_token_confirms_round_end_as_intermediate_message(delivery):
    from agent.interactions.events import ROUND_END

    passive_send, finish, streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}
    response = AgentResponse(text="查询结果")

    async def events():
        yield "token", "正在查询"
        yield ROUND_END, "正在查询"
        yield "token", "查询结果"
        yield "final", response

    final_text_sent, result, reply_text = await replies.send_qq_stream_by_round(
        payload, events(), show_intermediate_replies=True,
    )
    await finalize(payload, result, stream_sent=final_text_sent, stream_reply_text=reply_text)

    assert final_text_sent is True
    assert streamed == ["正在查询", "查询结果"]
    passive_send.assert_not_awaited()
    assert finish.call_args.args[0] == "success"


@pytest.mark.asyncio
async def test_round_end_followed_by_rewritten_final_uses_one_qq_message(delivery):
    from agent.interactions.events import ROUND_END

    passive_send, finish, streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}

    async def events():
        yield "token", "过早的草稿内容"
        yield ROUND_END, "过早的草稿内容"
        yield "final", AgentResponse(text="整理后的最终回答")

    stream_sent, response, reply_text = await replies.send_qq_stream_by_round(
        payload, events(), show_intermediate_replies=True,
    )
    await finalize(payload, response, stream_sent=stream_sent, stream_reply_text=reply_text)

    assert stream_sent is True
    assert streamed == ["整理后的最终回答"]
    passive_send.assert_not_awaited()
    assert finish.call_args.args[0] == "success"


@pytest.mark.asyncio
async def test_mermaid_only_final_is_delivered_as_image_without_replaying_source(delivery, monkeypatch):
    from agent.im import chart

    passive_send, finish, streamed = delivery
    image_send = AsyncMock(return_value=True)
    monkeypatch.setattr(replies, "_try_send_png_image", image_send)
    monkeypatch.setattr(chart, "render_chart_png", AsyncMock(return_value=b"synthetic-png"))
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}
    source = "```mermaid\nflowchart LR\n  A --> B\n```"

    async def events():
        yield "token", source
        yield "final", AgentResponse(text=source)

    stream_sent, response, reply_text = await replies.send_qq_stream_by_round(
        payload, events(), show_intermediate_replies=True,
    )
    await finalize(payload, response, stream_sent=stream_sent, stream_reply_text=reply_text)

    assert stream_sent is True
    assert reply_text == source
    assert streamed == []
    image_send.assert_awaited_once_with(payload, b"synthetic-png")
    passive_send.assert_not_awaited()
    assert finish.call_args.args[0] == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback_succeeds", [True, False])
async def test_partial_final_stream_only_suppresses_text_after_reliable_tail_delivery(
    delivery, monkeypatch, fallback_succeeds,
):
    from agent.gateway import qq
    from agent.interactions.events import ROUND_END

    streams = []

    class PartialStream:
        def __init__(self):
            self.parts = ""
            self.last_sent_text = ""
            self.sent = False
            streams.append(self)

        def push(self, text):
            self.parts += text

        async def finish(self, text, *, allow_rewrite=False):
            if len(streams) == 1:
                self.last_sent_text = text
                self.sent = True
                return
            self.last_sent_text = "最终"
            self.sent = True
            raise RuntimeError("synthetic stream tail failure")

        def has_sent(self):
            return self.sent

    monkeypatch.setattr(qq, "create_private_text_stream", lambda *_args, **_kwargs: PartialStream())
    fallback_send = AsyncMock(return_value=fallback_succeeds)
    monkeypatch.setattr(replies, "send_text", fallback_send)
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}

    async def events():
        yield "token", "前置轮"
        yield ROUND_END, "前置轮"
        yield "token", "最终正文"
        yield "final", AgentResponse(text="最终正文")

    if fallback_succeeds:
        final_text_sent, response, reply_text = await replies.send_qq_stream_by_round(
            payload, events(), show_intermediate_replies=True,
        )
        assert final_text_sent is True
        assert response.text == "最终正文"
        assert reply_text == "最终正文"
        fallback_send.assert_awaited_once_with({**payload, "message_id": None}, "正文")
    else:
        final_text_sent, response, reply_text = await replies.send_qq_stream_by_round(
            payload, events(), show_intermediate_replies=True,
        )
        assert final_text_sent is False
        assert response.text == "最终正文"
        assert reply_text is None
        fallback_send.assert_awaited_once_with({**payload, "message_id": None}, "正文")
        await finalize(payload, response, stream_sent=final_text_sent, stream_reply_text=reply_text)
        # 已确认“最终”前缀送达但尾部回退失败时，不能再把整段正文重发造成重复。
        fallback_send.assert_awaited_once()
        assert delivery[1].call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_stream_without_final_event_closes_partial_stream_then_raises(delivery):
    passive_send, _finish, streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}

    async def events():
        yield "token", "不完整的流"

    with pytest.raises(RuntimeError, match="QQ 回复未收到模型终态"):
        await replies.send_qq_stream_by_round(
            payload, events(), show_intermediate_replies=True,
        )

    passive_send.assert_not_awaited()
    assert streamed == ["不完整的流"]


@pytest.mark.asyncio
async def test_stream_exception_closes_partial_stream_before_propagating(delivery, monkeypatch):
    from agent.im import chart

    passive_send, _finish, streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}

    class PassThroughFilter:
        def __init__(self, **_kwargs):
            pass

        def ordered_events(self, events):
            return events

    monkeypatch.setattr(chart, "ProgressiveChartTokenFilter", PassThroughFilter)

    async def events():
        yield "token", "工具执行前的部分内容"
        raise RuntimeError("synthetic run failure")

    with pytest.raises(RuntimeError, match="synthetic run failure"):
        await replies.send_qq_stream_by_round(
            payload, events(), show_intermediate_replies=True,
        )

    assert streamed == ["工具执行前的部分内容"]
    passive_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_with_unknown_remote_status_notifies_im_user(delivery, monkeypatch):
    passive_send, finish, _streamed = delivery
    send_status = AsyncMock(return_value=True)
    monkeypatch.setattr(dispatch_finalization, "send_text", send_status)
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}

    response = await finalize(payload, AgentResponse(cancelled=True, remote_status_unknown=True))

    assert response.cancelled is True
    send_status.assert_awaited_once_with(payload, "本地已停止，远端执行状态未知")
    passive_send.assert_not_awaited()
    assert finish.call_args.args[0] == "cancelled"


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
    assert all(
        call.args[0].get("message_id") is None and call.args[1] == "最终结论"
        for call in fallback_send.await_args_list
    )
    assert passive_send.await_count == 0
    assert finish.call_args.args[0] == ("success" if fallback_succeeds else "error")


@pytest.mark.asyncio
async def test_c2c_error_notice_uses_active_reply_after_stream(delivery):
    passive_send, finish, _streamed = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-inbound"}
    await finalize(payload, AgentResponse(text="最终错误提示", errored=True), stream_sent=True)
    passive_send.assert_awaited_once()
    assert passive_send.await_args.args[1] == "最终错误提示"
    assert passive_send.await_args.args[2] is None
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
                   stream_sent=False)
    passive_send.assert_awaited_once()
    assert passive_send.await_args.args[0] == "synthetic-group"
    assert passive_send.await_args.args[1] == "最终提示"
    assert passive_send.await_args.args[2] == "synthetic-inbound"
    assert finish.call_args.args[0] == ("error" if errored else "success")
