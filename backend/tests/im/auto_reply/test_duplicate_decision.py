"""门开后模型又调了一次选择工具：按幂等处理，不让整条消息报废。

线上故障（2026-10-27 22:04，群 2652）：模型第一轮调用选择工具开门，
第二轮又调用了一次同一个工具（此时该工具已从 provider 的 schema 里移除，
但工具名还在对话历史里、提示词也还写着「必须调用一次」）。旧实现把这种
「重复调用」判成协议失败 → run 走 error 终态 → 群里一个字都没有，
两轮模型的 token 全部白烧。

这里锁住修复后的语义：既有选择权威、重复调用幂等、次数有上限。
"""
import json
from types import SimpleNamespace

import pytest

import agent.core as core
from agent.core import LLMRunner
from agent.im.auto_reply import (
    GROUP_REPLY_DECISION_TOOL,
    MAX_DUPLICATE_CHOICES,
    ReplyChoice,
    ReplyGate,
    tool_batch_allowed,
)


AI = SimpleNamespace(
    model="fake", base_url="http://local", api_key="dummy",
    provider="anthropic", max_tokens=100, thinking="disabled",
)


def _tool_use(call_id: str, name: str, arguments: dict) -> dict:
    return {"type": "tool_use", "id": call_id, "name": name, "input": arguments}


def _usage() -> SimpleNamespace:
    return SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0)


def _tool_round(name: str, arguments: dict, call_id: str = "call-1") -> SimpleNamespace:
    return SimpleNamespace(
        content=[_tool_use(call_id, name, arguments)],
        usage=_usage(),
        stop_reason="tool_use",
    )


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


def test_repeat_of_same_choice_is_idempotent():
    """重复同向选择：不改写选择，也不抛错。"""
    gate = ReplyGate()
    gate.choose(True)

    gate.choose(True)

    assert gate.choice is ReplyChoice.REPLY
    assert gate.may_reply is True
    assert gate.duplicate_choices == 1
    assert gate.conflicting_choices == 0


def test_repeat_with_string_choice_is_idempotent():
    """模型把布尔写成字符串（实测出现过 "true"）时同样按幂等放过。"""
    gate = ReplyGate()
    gate.choose(True)

    gate.choose("true")

    assert gate.choice is ReplyChoice.REPLY
    assert gate.duplicate_choices == 1
    assert gate.conflicting_choices == 0


def test_repeat_with_conflicting_choice_raises_but_keeps_first_choice():
    """冲突的重复仍然报错：既有选择权威，且不能被改写。"""
    gate = ReplyGate()
    gate.choose(True)

    with pytest.raises(ValueError):
        gate.choose(False)

    assert gate.choice is ReplyChoice.REPLY
    assert gate.conflicting_choices == 1


def test_duplicate_calls_are_bounded():
    """复读次数有上限：模型卡在复读里时仍会走到协议失败收尾，不会无限烧 token。"""
    gate = ReplyGate()
    gate.choose(True)

    for _ in range(MAX_DUPLICATE_CHOICES):
        assert tool_batch_allowed(gate, [GROUP_REPLY_DECISION_TOOL]) is True
        gate.choose(True)

    assert tool_batch_allowed(gate, [GROUP_REPLY_DECISION_TOOL]) is False
    # 业务工具不受影响：门开着时照常允许。
    assert tool_batch_allowed(gate, ["read_file"]) is True


@pytest.mark.asyncio
@pytest.mark.usefixtures("im_group_ctx")
async def test_duplicate_decision_call_does_not_kill_the_turn(monkeypatch):
    """复现线上故障：开门后模型又调一次门，整轮应当继续跑完而不是报废。"""
    fake, state = _provider_returning([
        _tool_round(GROUP_REPLY_DECISION_TOOL, {"should_reply": True}, "call-1"),
        _tool_round(GROUP_REPLY_DECISION_TOOL, {"should_reply": True}, "call-2"),
        _text_round("最终回复"),
    ])
    monkeypatch.setattr(core, "_stream_round", fake)

    gate = ReplyGate()
    events, wire_messages = await _run_turn(gate)

    # 关键回归点：重复调门没有把整轮判死，run 继续跑到了下一轮。
    assert state["index"] == 3, "重复调门之后应当继续跑完剩下的轮次"
    assert gate.choice is ReplyChoice.REPLY
    assert gate.duplicate_choices == 1, "重复调用应当按幂等记账，而不是协议失败"
    assert not [event for event in events if event.get("type") == "error"], \
        "重复调门不应把整轮判成协议失败"
    # 重复调用仍然被正常派发（拿得到工具回执），只是不再改写选择。
    wire_text = json.dumps(wire_messages, ensure_ascii=False)
    assert "call-2" in wire_text, "重复调门应当被正常派发并拿到工具回执"
    assert "selected" in wire_text
