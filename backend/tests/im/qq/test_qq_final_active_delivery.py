"""QQ 过程消息成功不能冒充最终交付；最终答复不依赖被动窗口和流关闭。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from agent.im import dispatch_finalization, replies
from agent.im.streaming.qq import collect_qq_response
from agent.models import AgentResponse


@pytest.fixture
def delivery(monkeypatch):
    from agent.gateway import qq

    send = AsyncMock(return_value=True)
    monkeypatch.setattr(qq, "send_c2c", send)
    monkeypatch.setattr(qq, "send_group", send)
    monkeypatch.setattr(qq, "create_private_text_stream", Mock(side_effect=AssertionError("最终策略不得开启流")))
    monkeypatch.setattr("agent.im.files.send_files", AsyncMock(return_value=SimpleNamespace(failed=False)))
    monkeypatch.setattr(dispatch_finalization, "persist_im_session", AsyncMock())
    monkeypatch.setattr(dispatch_finalization, "_should_observe_private_member_activity", lambda _: False)
    monkeypatch.setattr(dispatch_finalization, "finalize_im_response", AsyncMock())
    finish = Mock()
    monkeypatch.setattr(dispatch_finalization.trace, "finish_run", finish)
    return send, finish


async def finalize(payload, response):
    request = SimpleNamespace(source="qq", platform_user_id="synthetic-user", chat_id=None)
    return await dispatch_finalization.finalize_im_dispatch(
        payload=payload, request=request, route=SimpleNamespace(bot_id="synthetic-bot"),
        session_scope="synthetic", response=response, trace_id="synthetic-trace",
        sent_round_indices={0}, shown_interaction_ids=set(), show_intermediate_replies=True,
        # 故意保留“此前流已送达”，验证该布尔值不能跳过最终消息。
        stream_sent=True, stream_reply_text="过程说明",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("show_intermediate", [True, False])
async def test_final_is_sent_once_without_inbound_id_after_intermediate(delivery, show_intermediate):
    send, finish = delivery
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-expired"}
    response = AgentResponse(text="最终结论", round_texts=["过程说明", "最终结论"])

    async def events():
        yield "token", "过程说明"
        assert send.await_count == 0
        yield "round_end", "过程说明"
        yield "token", "最终结论"
        assert send.await_count == int(show_intermediate)
        yield "final", response

    result = await collect_qq_response(payload, events(), show_intermediate_replies=show_intermediate,
                                       send_completed_round=replies.send_completed_round)
    await finalize(payload, result)
    assert [call.args[1] for call in send.await_args_list] == (
        ["过程说明", "最终结论"] if show_intermediate else ["最终结论"])
    if show_intermediate:
        assert send.await_args_list[0].args[2] == "synthetic-expired"
    assert send.await_args_list[-1].args[2] is None
    assert payload["message_id"] == "synthetic-expired"
    assert finish.call_args.args[0] == "success"


@pytest.mark.asyncio
async def test_final_send_failure_is_not_reported_as_success_from_previous_stream(delivery):
    send, finish = delivery
    send.return_value = False
    payload = {"platform": "qq", "chat_type": "c2c", "platform_user_id": "synthetic-user",
               "channel_id": "synthetic-bot", "message_id": "synthetic-expired"}
    await finalize(payload, AgentResponse(text="最终结论"))
    assert send.await_count == 1
    assert send.await_args.args[2] is None
    assert finish.call_args.args[0] == "error"


@pytest.mark.asyncio
async def test_cancelled_run_does_not_send_active_final(delivery):
    send, finish = delivery
    await finalize({"platform": "qq"}, AgentResponse(text="未完成正文", cancelled=True))
    send.assert_not_awaited()
    assert finish.call_args.args[0] == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("errored", [True, False])
async def test_group_final_and_error_notice_are_active_without_replaying_rounds(delivery, errored):
    send, finish = delivery
    payload = {"platform": "qq", "chat_type": "group", "chat_id": "synthetic-group",
               "platform_user_id": "synthetic-user", "channel_id": "synthetic-bot",
               "message_id": "synthetic-expired"}
    await finalize(payload, AgentResponse(text="最终提示", round_texts=["过程说明"], errored=errored))
    assert send.await_count == 1
    assert send.await_args.args[0] == "synthetic-group"
    assert send.await_args.args[1] == "最终提示"
    assert send.await_args.args[2] is None
    assert finish.call_args.args[0] == ("error" if errored else "success")


@pytest.mark.asyncio
async def test_missing_model_terminal_is_not_fabricated_as_success():
    async def events():
        yield "token", "未完成正文"

    with pytest.raises(RuntimeError, match="未收到模型终态"):
        await collect_qq_response({}, events(), show_intermediate_replies=False,
                                  send_completed_round=AsyncMock())
