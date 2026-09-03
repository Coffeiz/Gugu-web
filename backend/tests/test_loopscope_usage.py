"""LoopScope 用量埋点回归测试：修复「监控数据全是 0」。

根因：`core._run_loop` 收到 ("done", …) 后立即 break，不再消费 driver 的
run_round 生成器；旧实现把 usage 记录放在 `traced_round` 的 async for 循环
**之后**，那段代码永远执行不到 → `run.usage`/`span.usage` 全为 0（LoopScope
前端 Input/Output/Cache read/Fresh input/Total 全 0）。

修复：在 `traced_round` 收到 ("done", …) 时、yield 之前就地记录 usage 并收尾
span；同时补 `except GeneratorExit`，让外层提前掐断（取消）时把 span 标成
cancelled 而不是误标 error。

本文件走真实 hooks 链路（ensure_hooks + LLMRunner._run_loop 包裹），复现
「done 后外层 break」与「流式中途掐断」两个场景。注意 `ensure_hooks()` 是
进程级全局替换，fixture 在安装前保存现场、测试结束后还原，避免污染同一
pytest 进程里的其它测试文件。
"""
import asyncio
import collections
import json
from types import SimpleNamespace

import pytest

import agent.core as core
from agent.core import LLMRunner, _provider_context_usage
from agent.runtime.loopscope_trace import hooks as loop_hooks
from agent.runtime.loopscope_trace.state import _ScopeRun, _now, _scope_run

AI = SimpleNamespace(model="fake", base_url="http://local", api_key="dummy",
                     provider="anthropic", max_tokens=100, temperature=0.7,
                     thinking="disabled")

# anthropic 口径（utils._usage_payload）：usage_in=10 / output=5 / cache_read=3
#   input = 10 + 3 + 0 = 13，fresh_input = usage_in = 10，total = 18，cache_ratio = 3/13
EXPECTED_USAGE = {
    "input": 13, "output": 5, "cache_read": 3, "cache_write": 0,
    "fresh_input": 10, "total": 18, "cache_ratio": round(3 / 13, 6),
}


def test_context_threshold_uses_cache_tokens_for_anthropic():
    result = SimpleNamespace(usage_in=1080, cache_tokens=75456)
    assert _provider_context_usage(SimpleNamespace(api_format="anthropic"), result) == 76536


def test_context_threshold_adds_openai_cache_tokens_after_usage_normalization():
    """driver 已把 OpenAI usage 归一成「未命中输入」：usage_in=20k + cache=80k
    → 真实上下文 100k，不能再按旧口径只取 usage_in（会漏掉缓存命中的 80k）。"""
    result = SimpleNamespace(usage_in=20, cache_tokens=80)
    assert _provider_context_usage(SimpleNamespace(api_format="openai"), result) == 100


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """跑得快：退避/打字延迟不用真等。"""
    async def _fast_sleep(_seconds):
        return None
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)


@pytest.fixture()
def loopscope_hooks(monkeypatch):
    """模拟生产 LOOPSCOPE_ENABLED=1：安装全局钩子，测试结束后还原现场。"""
    from agent.context import builder as context_builder
    from agent.context import loaders as context_loaders
    from agent.llm import genstream
    from agent.tools import registry

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")

    saved = {
        "begin": genstream.begin,
        "publish": genstream.publish,
        "dispatch": registry.dispatch,
        "run_loop": LLMRunner._run_loop,
        "build_split": getattr(context_builder, "build_split", None),
        "hooks_installed": loop_hooks._hooks_installed,
    }
    for name in ("load_projects", "load_user_tz", "load_events", "load_files_overview",
                 "load_style_prefs", "load_memory", "load_im_channels"):
        saved[f"loader:{name}"] = getattr(context_loaders, name, None)

    loop_hooks.ensure_hooks()
    assert loop_hooks._hooks_installed  # LOOPSCOPE_ENABLED=1 下应安装成功

    yield

    genstream.begin = saved["begin"]
    genstream.publish = saved["publish"]
    registry.dispatch = saved["dispatch"]
    LLMRunner._run_loop = saved["run_loop"]
    if saved["build_split"] is not None:
        context_builder.build_split = saved["build_split"]
    for name in ("load_projects", "load_user_tz", "load_events", "load_files_overview",
                 "load_style_prefs", "load_memory", "load_im_channels"):
        orig = saved.get(f"loader:{name}")
        if orig is not None:
            setattr(context_loaders, name, orig)
    loop_hooks._hooks_installed = saved["hooks_installed"]


async def drain(gen):
    """跑完 SSE 生成器，返回 (事件计数, 吐出的 token 文本, error detail 列表)。"""
    ev = collections.Counter()
    text = []
    errors = []
    async for chunk in gen:
        try:
            d = json.loads(chunk[len("data: "):])
        except Exception:
            continue
        ev[d.get("type")] += 1
        if d.get("type") == "token":
            text.append(d.get("content", ""))
        elif d.get("type") == "error":
            errors.append(d.get("detail", ""))
    return ev, "".join(text), errors


async def test_usage_lands_before_done_break(monkeypatch, loopscope_hooks):
    """收到 ("done", …) 后外层 _run_loop 立即 break：usage 也必须已落地。

    回归保护：LoopScope 监控用量不能全为 0（旧实现在生成器循环结束后才记
    usage，被 done-break 跳过，`run.usage`/`span.usage` 一直是空/全 0）。
    """
    final = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="你好")],
        usage=SimpleNamespace(input_tokens=10, output_tokens=5,
                              cache_read_input_tokens=3),
    )

    async def fake_stream_round(client, kwargs, adapter=None):
        yield ("token", "你")
        yield ("token", "好")
        yield ("final", final)

    monkeypatch.setattr(core, "_stream_round", fake_stream_round)

    run = _ScopeRun(
        id="run-test-usage", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        messages = [{"role": "user", "content": "你好"}]
        runner = LLMRunner(tool_names=[], settings=SimpleNamespace(ai=AI))
        ev, text, errors = await drain(
            runner._run_anthropic("u", "sys", messages, AI, session_id=388)
        )
    finally:
        _scope_run.reset(token)

    # 主循环本身照常工作：SSE 照吐、_usage 行照发、无 error
    assert text == "你好"
    assert errors == []
    assert ev["_usage"] == 1
    assert ev["error"] == 0

    # 回归核心：run 级用量已落地（不是全 0）
    assert run.usage == EXPECTED_USAGE, f"run.usage 未落地：{run.usage}"

    # LLM 轮 span 应成功收尾并带用量（不是 error/cancelled/running）
    llm = [s for s in run.spans if s.kind == "llm"]
    assert len(llm) == 1
    assert llm[0].status == "success", f"span 状态异常：{llm[0].status}"
    assert llm[0].usage == EXPECTED_USAGE, f"span.usage 未落地：{llm[0].usage}"
    assert llm[0].token_impact["prompt_tokens_actual"] == EXPECTED_USAGE["input"]
    assert llm[0].token_impact["prompt_tokens_source"] == "provider"

    assembly = llm[0].input["assembly"]
    assert assembly["system"]["location"] == "system_param"
    assert assembly["system"]["reused"] is False
    assert assembly["system"]["digest"]
    assert assembly["messages"]["count"] == 1


async def test_loopscope_wrapper_without_active_run_accepts_session_id(monkeypatch, loopscope_hooks):
    """没有 active LoopScope run 的 IM 路径也必须能透传 session_id。"""
    final = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="收到")],
        usage=SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0),
    )

    async def fake_stream_round(client, kwargs, adapter=None):
        yield ("token", "收到")
        yield ("final", final)

    monkeypatch.setattr(core, "_stream_round", fake_stream_round)
    runner = LLMRunner(tool_names=[], settings=SimpleNamespace(ai=AI))
    ev, text, errors = await drain(
        runner._run_anthropic("u", "sys", [{"role": "user", "content": "测试"}], AI,
                              session_id=388)
    )

    assert ev["_usage"] == 1
    assert text == "收到"
    assert errors == []


async def test_mid_stream_abort_marks_span_cancelled(monkeypatch, loopscope_hooks):
    """流式中途被掐断（外层提前 return）：span 应标 cancelled，不能误标 error。

    回归保护：`traced_round` 的 `except GeneratorExit` 分支——旧实现没有该分支，
    外层 break/return 关生成器时 GeneratorExit 会掉进 `except BaseException`，
    把正常被取消的 span 误标成 error。
    """
    final = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="不应该到达")],
        usage=SimpleNamespace(input_tokens=10, output_tokens=5,
                              cache_read_input_tokens=0),
    )

    async def fake_stream_round(client, kwargs, adapter=None):
        # 一直吐 token、不给 final：让 _run_loop 在流式途中撞上取消检查点
        for i in range(30):
            yield ("token", f"字{i}")
        yield ("final", final)

    monkeypatch.setattr(core, "_stream_round", fake_stream_round)

    # 第一处在轮开始前的检查要放行，第二处（流式途中 _tok % 24 == 0）再掐断
    calls = {"n": 0}

    async def fake_cancel(_session_id=None):
        calls["n"] += 1
        return calls["n"] >= 2

    monkeypatch.setattr(core, "_im_cancelled", fake_cancel)

    run = _ScopeRun(
        id="run-test-cancel", trace_id="trace-test",
        session_key="gugu:web:test-session", external_session_id="test-session",
        source="web", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        messages = [{"role": "user", "content": "算了"}]
        runner = LLMRunner(tool_names=[], settings=SimpleNamespace(ai=AI))
        ev, _text, errors = await drain(runner._run_anthropic("u", "sys", messages, AI))
    finally:
        _scope_run.reset(token)

    assert ev["_cancelled"] == 1
    assert errors == []

    llm = [s for s in run.spans if s.kind == "llm"]
    assert len(llm) == 1
    assert llm[0].status == "cancelled", f"span 应标 cancelled，实际：{llm[0].status}"

    # 没有 done → 用量不应落地（这轮没跑完，不产生用量）
    assert run.usage == {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                         "fresh_input": 0, "total": 0, "cache_ratio": 0.0}
