"""群聊选择门的两条兜底：越权调用回灌后能恢复，provider 强制能防住绕过。

实测线上（群「奇怪」，22:33 之后）：52 个走选择门的 run 里 5 个因为模型
绕过选择门而整条丢失（9.6%）。两种绕过方式：

- 模型直接写正文、不调任何工具（没有工具调用可以返回错误）；
- 模型用 call_tool 元工具去干业务（provider 不校验工具名，调用原样送达）。

前者靠 provider 原生强制 tool_choice 根治，后者靠把越权调用降级成工具级
错误回灌给模型——两条都写在这里。
"""
import json
from types import SimpleNamespace

import pytest

import agent.core as core
from agent.core import LLMRunner
from agent.im.auto_reply import (
    GROUP_NO_REPLY_TOOL,
    ReplyChoice,
    ReplyGate,
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
    state = {"index": 0}

    async def fake_stream_round(_client, _kwargs, adapter=None):
        index = min(state["index"], len(rounds) - 1)
        state["index"] += 1
        yield ("final", rounds[index])

    return fake_stream_round, state


@pytest.fixture
def im_group_ctx():
    from agent.im import imctx

    imctx.set_im(
        platform="qq", message_id="m-1", channel_id="bot-1", chat_id="g-1",
        puid="u-1", chat_type="group", group_auto_reply=True,
    )
    yield
    imctx.clear()


@pytest.fixture
def dispatched_tools(monkeypatch):
    """记录真正被执行过的工具名。"""
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
async def test_model_bypassing_the_gate_recovers_in_the_same_run(monkeypatch, dispatched_tools):
    """模型用元工具绕开门 → 那个调用不执行 → 错误回灌 → 它补调门后正常跑完。"""
    fake, state = _provider_returning([
        _tool_round("call_tool", {"tool_name": "read_file", "arguments": {"path": "x"}}, "call-1"),
        _tool_round(GROUP_NO_REPLY_TOOL, {"should_reply": True}, "call-2"),
        _text_round("最终回复"),
    ])
    monkeypatch.setattr(core, "_stream_round", fake)

    gate = ReplyGate()
    events, wire_messages = await _run_turn(gate)

    assert "read_file" not in dispatched_tools, "绕门调用的业务工具被执行了"
    assert gate.choice is ReplyChoice.REPLY, "模型补调选择工具后门应当打开"
    assert state["index"] == 3, "应该多跑一轮让模型纠正"

    # 协议错误回灌给模型：模型要知道自己先得做选择。
    wire_text = json.dumps(wire_messages, ensure_ascii=False)
    assert "group_reply_decision" in wire_text

    # 恢复之后不该再有协议错误终态。
    assert not [event for event in events if event.get("type") == "error"]


def _runtime(api_format: str, gate: ReplyGate):
    from agent.loop.round_runtime import ProviderRoundRuntime

    ctx = SimpleNamespace(
        base_think_kwargs={"extra_body": {"thinking": {"type": "enabled"}}},
        disabled_think_kwargs={"extra_body": {"thinking": {"type": "disabled"}}},
        think_kwargs={"extra_body": {"thinking": {"type": "enabled"}}},
        forced_tool_choice=None,
    )
    driver = SimpleNamespace(
        api_format=api_format,
        update_tools=lambda *_args, **_kwargs: None,
    )
    runner = SimpleNamespace(
        group_reply_gate=gate,
        tool_names=[],
        capability_context=None,
        _provider_tool_names=lambda names: list(names),
    )
    runtime = ProviderRoundRuntime(
        runner=runner, driver=driver, client=None, context=ctx,
        ai=SimpleNamespace(), messages=SimpleNamespace(), system_text=None,
        tool_snapshot=None, tool_names=[], stream_round=None,
    )
    return runtime, ctx


def test_gate_round_forces_tool_choice_on_openai_format():
    """还没做选择那一轮：强制 tool_choice 指向选择工具，并显式关掉思考。"""
    gate = ReplyGate()
    runtime, ctx = _runtime("openai", gate)

    runtime._refresh_tools()

    assert ctx.forced_tool_choice == {
        "type": "function",
        "function": {"name": GROUP_NO_REPLY_TOOL},
    }
    # 关思考必须显式发参数：省略等于沿用 provider 默认（DeepSeek 默认开着思考，
    # 会直接拒收强制 tool_choice）。
    assert ctx.think_kwargs == {"extra_body": {"thinking": {"type": "disabled"}}}


def test_forced_tool_choice_is_dropped_once_the_gate_opens():
    """门开了之后恢复用户配置的思考，并且不再强制工具选择。"""
    gate = ReplyGate()
    runtime, ctx = _runtime("openai", gate)

    runtime._refresh_tools()
    gate.choose(True)
    runtime._refresh_tools()

    assert ctx.forced_tool_choice is None
    assert ctx.think_kwargs == ctx.base_think_kwargs


def test_anthropic_format_never_forces_tool_choice():
    """Anthropic 协议强制 tool_choice 会打崩前缀缓存，不走强制。"""
    gate = ReplyGate()
    runtime, ctx = _runtime("anthropic", gate)

    runtime._refresh_tools()

    assert ctx.forced_tool_choice is None
    assert ctx.think_kwargs == ctx.base_think_kwargs


def test_provider_rejecting_forced_tool_choice_disables_it_for_the_run():
    """provider 拒收强制 tool_choice：本 run 退回普通 tool_choice，不再强求。"""
    gate = ReplyGate()
    runtime, ctx = _runtime("openai", gate)

    runtime._refresh_tools()
    assert ctx.forced_tool_choice is not None

    # 驱动侧收到 400 后的回调：gate 记住这个 provider 不支持强制。
    ctx.on_forced_tool_choice_rejected()
    runtime._refresh_tools()

    assert gate.tool_choice_supported is False
    assert ctx.forced_tool_choice is None
    assert ctx.think_kwargs == ctx.base_think_kwargs


class _FakeProviderError(Exception):
    def __init__(self, status: int, text: str):
        super().__init__(text)
        self.status_code = status


def test_only_tool_choice_rejections_are_treated_as_capability_limits():
    """只有 4xx 且提到 tool_choice 才算能力不支持；别的 400 照旧当失败。"""
    from agent.loop_drivers import _is_forced_tool_choice_rejected

    assert _is_forced_tool_choice_rejected(
        _FakeProviderError(400, "Thinking mode does not support this tool_choice")
    ) is True
    assert _is_forced_tool_choice_rejected(
        _FakeProviderError(400, "invalid request: messages must not be empty")
    ) is False
    assert _is_forced_tool_choice_rejected(
        _FakeProviderError(500, "tool_choice is temporarily unavailable")
    ) is False


@pytest.mark.asyncio
async def test_openai_retries_without_provider_rejected_forced_tool_choice():
    """Provider 拒绝强制选择后，重试请求必须移除 tool_choice 并恢复思考参数。"""
    from agent.context.assembly.area import MessageArea
    from agent.loop_drivers import OpenAIDriver

    calls = []

    class EmptyStream:
        def __aiter__(self):
            async def iterate():
                if False:
                    yield None
            return iterate()

        async def close(self):
            return None

    class Completions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise _FakeProviderError(400, "unsupported tool_choice")
            return EmptyStream()

    from agent.providers.base import ProviderAdapter

    class Adapter(ProviderAdapter):
        api_format = "openai"

        def build_tool_params(self, _ai, tools):
            return {"tools": tools}

        def build_openai_cache_kwargs(self, _ai):
            return {}

    ctx = SimpleNamespace(
        supports_explicit_cache=False,
        adapter=Adapter(),
        tools=[{"type": "function", "function": {"name": "group_reply_decision"}}],
        forced_tool_choice={
            "type": "function", "function": {"name": "group_reply_decision"},
        },
        think_kwargs={"thinking": False},
        base_think_kwargs={"reasoning_effort": "low"},
        max_tokens=64,
        model="synthetic-model",
        ai=SimpleNamespace(provider="synthetic"),
    )
    expected_choice = dict(ctx.forced_tool_choice)
    client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    messages = MessageArea.from_canonical_messages([{"role": "user", "content": "合成群消息"}])
    events = [event async for event in OpenAIDriver().run_round(client, ctx, messages)]

    assert len(calls) == 2
    assert calls[0]["tool_choice"] == expected_choice
    assert "tool_choice" not in calls[1]
    assert calls[1]["reasoning_effort"] == "low"
    assert ctx.forced_tool_choice is None
    assert events[-1][0] == "done"
