"""保护同批选择静默与业务工具时，业务工具不会执行。"""
import json
from types import SimpleNamespace

import pytest

import agent.core as core
from agent.core import LLMRunner
from agent.im.auto_reply import GROUP_NO_REPLY_TOOL, ReplyGate


AI = SimpleNamespace(
    model="fake", base_url="http://local", api_key="dummy",
    provider="anthropic", max_tokens=100, context_tokens=4096, thinking="disabled",
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
async def test_silence_and_business_tool_in_same_batch_suppresses_business_tool(monkeypatch, dispatched_tools):
    """静默选择与其它工具同批时，除静默选择外整批副作用均被拒绝。"""
    fake, _state = _provider_returning([
        SimpleNamespace(
            content=[
                _tool_use("call-1", GROUP_NO_REPLY_TOOL, {}),
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

    # 业务调用被拒绝时会得到安全、可读的工具结果；静默决定结束本轮。
    wire_text = json.dumps(wire_messages, ensure_ascii=False)
    assert "本轮已明确选择不回复" in wire_text
    assert not [event for event in events if event.get("type") == "error"]
