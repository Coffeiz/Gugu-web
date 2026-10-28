"""保护群聊回复选择门的协议拒绝：越权工具一个都不能执行，错误回灌给模型。

这条不变量来自 PRD-IM-16 §4/§6——provider 一次返回选择调用和业务调用时，
服务端门禁必须在执行任何业务工具之前拦住它。拦下之后不是把整轮判死，而是把
协议错误当成工具结果回灌给模型，让它在同一 run 内补调选择工具后继续跑完；
只有连续违规超上限才落错误终态，且事件里不能出现内部实现术语（PRD-IM-16 §6）。
"""
import json
from types import SimpleNamespace

import pytest

import agent.core as core
from agent.core import LLMRunner
from agent.im.auto_reply import GROUP_NO_REPLY_TOOL, ReplyGate


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
    """选择工具有专门的权限门：只有群聊 + group_auto_reply 时才放行。"""
    from agent.im import imctx

    imctx.set_im(
        platform="qq", message_id="m-1", channel_id="bot-1", chat_id="g-1",
        puid="u-1", chat_type="group", group_auto_reply=True,
    )
    yield
    imctx.clear()


@pytest.fixture
def dispatched_tools(monkeypatch):
    """记录真正被执行过的工具，用于断言越权调用一个都没跑。"""
    from agent.tools import registry

    calls: list[str] = []
    original = registry.dispatch

    async def recording_dispatch(user_id, name, args):
        calls.append(name)
        return await original(user_id, name, args)

    monkeypatch.setattr(registry, "dispatch", recording_dispatch)
    return calls


async def _run_turn(gate: ReplyGate) -> tuple[list[dict], list[dict]]:
    from agent.context.assembly.area import MessageArea
    from agent.im.auto_reply import build_group_reply_decision_tool

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


@pytest.mark.asyncio
@pytest.mark.usefixtures("im_group_ctx")
async def test_violating_business_tool_never_runs(monkeypatch, dispatched_tools):
    """门还没开就调业务工具：那个工具一个都不能执行，错误回灌给模型。"""
    fake, _state = _provider_returning([
        SimpleNamespace(
            content=[
                _tool_use("call-1", GROUP_NO_REPLY_TOOL, {"should_reply": True}),
                _tool_use("call-2", "read_file", {"path": "synthetic"}),
            ],
            usage=_usage(),
            stop_reason="tool_use",
        ),
        _text_round("最终回复"),
    ])
    monkeypatch.setattr(core, "_stream_round", fake)

    gate = ReplyGate()
    events, wire_messages = await _run_turn(gate)

    assert "read_file" not in dispatched_tools, "越权的业务工具被执行了"
    assert GROUP_NO_REPLY_TOOL in dispatched_tools, "选择工具本身必须能执行"

    # 协议错误要真的回给模型，模型才知道要先做选择。
    wire_text = json.dumps(wire_messages, ensure_ascii=False)
    assert "group_reply_decision" in wire_text, "协议错误没有回给模型"

    # 单次违规不判死整轮。
    assert not [event for event in events if event.get("type") == "error"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("im_group_ctx")
async def test_repeated_violations_end_run_with_structured_error(monkeypatch, dispatched_tools):
    """连续违规超上限：落 error 终态，群里依旧一个字都没有，且不暴露内部术语。"""
    fake, state = _provider_returning([
        _tool_round("read_file", {"path": "synthetic"}, "call-1"),
        _tool_round("read_file", {"path": "synthetic"}, "call-2"),
        _tool_round("read_file", {"path": "synthetic"}, "call-3"),
    ])
    monkeypatch.setattr(core, "_stream_round", fake)

    gate = ReplyGate()
    events, _wire = await _run_turn(gate)

    assert state["index"] == 3, "连续违规超上限才终止"
    assert "read_file" not in dispatched_tools, "越权的业务工具被执行了"

    errors = [event for event in events if event.get("type") == "error"]
    assert len(errors) == 1
    error = errors[0]
    assert error["error_code"] == "group_reply_protocol"
    assert error["message_key"] == "chatUi.groupReplyFailed"
    # 事件会原样流到网页端，内部的工具名/协议术语不能出现在可见字段里。
    visible = json.dumps(
        {key: error.get(key) for key in ("message", "detail", "message_key")},
        ensure_ascii=False,
    )
    assert GROUP_NO_REPLY_TOOL not in visible
    assert "read_file" not in visible
