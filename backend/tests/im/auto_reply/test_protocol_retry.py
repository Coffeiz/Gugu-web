"""群聊选择门的协议纠错：模型直接输出正文时，把协议错误回给它重选。

保护的是 PRD-IM-16 §4 的「必须先做出回复选择」：模型跳过选择工具自顾自输出
正文时，本轮内容不会发进群；服务端把「你还没做选择」作为协议错误回给模型，
让它在同一 run 内补调 group_reply_decision，而不是静默吞掉这条回复。
"""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import agent.core as core
from agent.core import LLMRunner
from agent.im.auto_reply import (
    GROUP_NO_REPLY_TOOL,
    ReplyChoice,
    ReplyGate,
    check_protocol_violation,
)


AI = SimpleNamespace(
    model="fake", base_url="http://local", api_key="dummy",
    provider="anthropic", max_tokens=100, thinking="disabled",
)


def _tool_use(call_id: str, name: str, arguments: dict) -> dict:
    return {"type": "tool_use", "id": call_id, "name": name, "input": arguments}


def _usage() -> SimpleNamespace:
    return SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0)


def _text_round(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        content=[{"type": "text", "text": text}],
        usage=_usage(),
        stop_reason="end_turn",
    )


def _tool_round(name: str, arguments: dict, call_id: str = "call-1") -> SimpleNamespace:
    return SimpleNamespace(
        content=[_tool_use(call_id, name, arguments)],
        usage=_usage(),
        stop_reason="tool_use",
    )


def _provider_returning(rounds: list[SimpleNamespace]):
    """按顺序返回若干轮 provider 结果；用尽后重复最后一轮。"""
    state = {"index": 0}

    async def fake_stream_round(_client, _kwargs, adapter=None):
        index = min(state["index"], len(rounds) - 1)
        state["index"] += 1
        yield ("final", rounds[index])

    return fake_stream_round, state


@pytest.fixture
def im_group_ctx():
    """选择工具有专门的权限门：只有群聊 + group_auto_reply 时才放行
    （agent/im/permissions.py），所以测试必须带上真实 IM 上下文。
    """
    from agent.im import imctx

    imctx.set_im(
        platform="qq", message_id="m-1", channel_id="bot-1", chat_id="g-1",
        puid="u-1", chat_type="group", group_auto_reply=True,
    )
    yield
    imctx.clear()


async def _run_turn(gate: ReplyGate) -> tuple[list[dict], list[dict]]:
    from agent.context.assembly.area import MessageArea
    from agent.im.auto_reply import build_group_reply_decision_tool

    # 选择工具在真实链路里是作为本轮动态工具传进来的（run/preparation.py），
    # dispatch 必须能在工具快照里找到它，否则「模型调了选择工具」不会真正改写 gate。
    runner = LLMRunner(
        tool_names=[],
        settings=SimpleNamespace(ai=AI),
        dynamic_tools=[build_group_reply_decision_tool(gate)],
    )
    runner.group_reply_gate = gate
    messages = MessageArea.from_canonical_messages([
        {"role": "user", "content": "群成员的消息"},
    ])
    events = []
    async for chunk in runner._run_anthropic("u", "sys", messages, AI, session_id=None):
        events.append(chunk)
    parsed = []
    for chunk in events:
        if not chunk.startswith("data: "):
            continue
        try:
            parsed.append(json.loads(chunk[len("data: "):]))
        except ValueError:
            continue
    return parsed, messages.provider_projection().to_messages()


@pytest.mark.parametrize(
    "choice,has_text,expected",
    [
        # 还没做选择却产出了正文：模型自顾自答了，属于协议违反。
        (ReplyChoice.PENDING, True, "retry"),
        # 没做选择也没正文：模型选择不说话，正常静默，不算违反。
        (ReplyChoice.PENDING, False, ""),
        # 已经做出选择，不再受协议纠错管辖。
        (ReplyChoice.REPLY, True, ""),
        (ReplyChoice.SILENT, True, ""),
    ],
)
def test_protocol_violation_classification(choice, has_text, expected):
    gate = ReplyGate(choice=choice)

    assert check_protocol_violation(gate, has_text=has_text) == expected


def test_protocol_violation_exhausts_after_limit():
    """纠错上限用尽后不再无限追问，否则协议冲突时会一直烧 token。"""
    gate = ReplyGate()

    assert check_protocol_violation(gate, has_text=True) == "retry"
    assert check_protocol_violation(gate, has_text=True) == "exhausted"


@pytest.mark.asyncio
@pytest.mark.usefixtures("im_group_ctx")
async def test_direct_text_output_triggers_protocol_retry_then_model_chooses(monkeypatch):
    """模型直接输出正文 → 服务端把协议错误回给它 → 它补调选择工具后正常继续。"""
    fake, state = _provider_returning([
        _text_round("模型直接输出的正文"),
        _tool_round(GROUP_NO_REPLY_TOOL, {"should_reply": True}, "call-2"),
        _text_round("最终回复"),
    ])
    monkeypatch.setattr(core, "_stream_round", fake)

    gate = ReplyGate()
    events, wire_messages = await _run_turn(gate)

    # 正文轮 + 纠错轮 + 拿到选择后的正常轮
    assert state["index"] == 3, "应该在纠错轮重新请求一次模型"
    assert gate.choice is ReplyChoice.REPLY
    assert any(event.get("type") == "_new_round" for event in events)

    # 协议错误必须真的回给模型，否则模型无从知道要重新做选择。
    wire_text = json.dumps(wire_messages, ensure_ascii=False)
    assert "【内部协议错误" in wire_text, "协议错误没有回给模型"
    assert "group_reply_decision" in wire_text

    # 补选之后模型照常跑完，没有再触发协议失败。
    assert not [event for event in events if event.get("type") == "error"]

    # 未获许可的正文只留在本次请求的上下文里（供模型重答），不得出现在对外事件中。
    event_text = json.dumps(events, ensure_ascii=False)
    assert "模型直接输出的正文" not in event_text, "未获许可的正文不得对外可见"


@pytest.mark.asyncio
async def test_protocol_retry_exhausted_ends_run_with_error_and_no_visible_output(monkeypatch):
    """纠错后仍不做选择：落 error 终态，群里依旧一个字都没有。"""
    fake, state = _provider_returning([
        _text_round("第一次直接输出的正文"),
        _text_round("纠错后仍然直接输出的正文"),
    ])
    monkeypatch.setattr(core, "_stream_round", fake)

    gate = ReplyGate()
    events, _wire = await _run_turn(gate)

    assert state["index"] == 2, "只纠错一轮，第二次仍违反就终止"
    assert gate.choice is ReplyChoice.PENDING
    errors = [event for event in events if event.get("type") == "error"]
    assert len(errors) == 1
    assert errors[0]["error_code"] == "group_reply_protocol"
    # 可见错误走 i18n key，界面按语言取文案；措辞不引导用户「再说一遍」
    # （群消息触发的回复，用户并没有对咕咕说过话）。
    assert errors[0]["message_key"] == "chatUi.groupReplyFailed"
    assert "再说一遍" not in errors[0]["message"]
    assert not any(event.get("type") == "token" for event in events)


@pytest.mark.asyncio
async def test_decision_tool_is_silent_on_im_but_kept_in_web_mirror(monkeypatch):
    """选择工具是内部协议信号：群里不显示，Web 镜像照常保留（排查靠它）。"""
    from agent.im import presentation

    send_tool_event = AsyncMock()
    monkeypatch.setattr("agent.im.replies.send_tool_event", send_tool_event, raising=False)
    published: list[dict] = []

    async def publish(event):
        published.append(event)

    decision_event = {
        "type": "tool_call",
        "tool_call_id": "call-1",
        "name": GROUP_NO_REPLY_TOOL,
        "label": "群聊回复选择",
    }
    await presentation.display_tool_event(
        {"platform": "qq", "chat_type": "group"},
        decision_event,
        tool_display_mode="all",
        publish_web_event=publish,
    )

    assert published == [decision_event], "Web 端必须保留选择工具调用"
    send_tool_event.assert_not_awaited(), "群里不得出现选择工具消息"

    # 普通工具不受影响，仍然按用户偏好展示到 IM。
    await presentation.display_tool_event(
        {"platform": "qq", "chat_type": "group"},
        {"type": "tool_call", "tool_call_id": "call-2", "name": "read_file", "label": "读文件"},
        tool_display_mode="all",
        publish_web_event=publish,
    )
    send_tool_event.assert_awaited_once()
