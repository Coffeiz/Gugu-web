"""PRD-LLM-18 LLM18-006：run 生命周期回归。

覆盖 FR-RUN-04 的关键不变量：
- final 不早于持久化：finalize_run 必须先于渠道广播与最终响应；
- 同一 run 的 canonical history/usage 只写一次；
- AsyncSession 不跨 LLM 等待复用（准备期产生的会话全部在执行前关闭）；
- 错误/取消出口不触发持久化与广播。
"""
from __future__ import annotations

import dataclasses
import json

import pytest

from agent.models import AgentRequest, AgentResponse


def _sse(event: dict) -> str:
    return "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"


def _success_stream():
    return iter([
        _sse({"type": "token", "content": "你好"}),
        _sse({"type": "_usage", "input": 10, "output": 2, "cache_read": 0, "cache_write": 0}),
        _sse({"type": "_new_round", "next_round": 2}),
        _sse({"type": "round_start"}),
        _sse({"type": "token", "content": "搞定"}),
    ])


class _StubRunner:
    def __init__(self, events):
        self._events = events
        self.tool_names = []

    def run(self, *args, **kwargs):
        async def _gen():
            for event in self._events:
                yield event
        return _gen()


def _stub_exec(runner):
    from agent.run.contract import PreparedExecution

    class _Cfg:
        reasoning_persistence = "persist"
        model = object()

    class _Policy:
        allow_memory_reflection = False

    class _Prepared:
        anthr_messages = [{"role": "user", "content": "hi"}]
        anthr_initial_len = 1
        oa_messages = []
        oa_initial_len = 0
        rag_context = {}
        stance_to_persist = None

    return PreparedExecution(
        session_id=7, is_new_session=True, session=object(), snapshot={},
        system_prompt="sys", user_message=type("M", (), {"id": 5})(),
        model_cfg=object(), run_config=_Cfg(), use_anthropic=True,
        context_policy=_Policy(), runner=runner, prepared=_Prepared(),
        session_factory=lambda: None, settings=object(),
    )


@pytest.mark.asyncio
async def test_finalize_precedes_publish_and_final_response(monkeypatch):
    """finalize_run 先于渠道广播与最终响应；同一 run 只持久化一次。"""
    from agent import runner
    from agent.run.contract import EarlyExit  # noqa: F401  (确保契约可导入)

    order: list[str] = []
    finalize_calls = 0

    async def fake_prepare(req, *, non_streaming):
        return _stub_exec(_StubRunner(list(_success_stream())))

    async def fake_finalize(**kwargs):
        nonlocal finalize_calls
        finalize_calls += 1
        order.append("finalize")

    async def fake_publish(user_id, *resources, **kwargs):
        order.append("publish")

    monkeypatch.setattr(runner, "prepare_agent_run", fake_prepare)
    from agent.context import run_finalize
    monkeypatch.setattr(run_finalize, "finalize_run", fake_finalize)
    from app.core import events as evmod
    monkeypatch.setattr(evmod, "publish", fake_publish)

    req = AgentRequest(message="hi", user_id="u1", user_name="coffeiz")
    response = await runner._run_collect_unlocked(req)

    assert response.text == "搞定" and response.errored is False
    assert finalize_calls == 1, "canonical history/usage 必须只写一次"
    assert order == ["finalize", "publish"], f"收尾顺序漂移：{order}"


@pytest.mark.asyncio
async def test_errored_and_cancelled_exits_skip_persistence(monkeypatch):
    """错误与取消出口：不持久化、不广播、响应用对应终态。"""
    from agent import runner

    async def fake_prepare(req, *, non_streaming):
        return _stub_exec(_StubRunner([_sse({"type": "error", "detail": "上游繁忙"})]))

    finalize_calls = 0

    async def fake_finalize(**kwargs):
        nonlocal finalize_calls
        finalize_calls += 1

    async def fake_publish(*args, **kwargs):
        raise AssertionError("中断出口不得触发渠道广播")

    monkeypatch.setattr(runner, "prepare_agent_run", fake_prepare)
    from agent.context import run_finalize
    monkeypatch.setattr(run_finalize, "finalize_run", fake_finalize)
    from app.core import events as evmod
    monkeypatch.setattr(evmod, "publish", fake_publish)

    req = AgentRequest(message="hi", user_id="u1", user_name="coffeiz")
    response = await runner._run_collect_unlocked(req)
    assert response.errored is True and response.text == "上游繁忙"
    assert finalize_calls == 0

    async def fake_prepare_cancel(req, *, non_streaming):
        return _stub_exec(_StubRunner([_sse({"type": "_cancelled"})]))

    monkeypatch.setattr(runner, "prepare_agent_run", fake_prepare_cancel)
    cancelled = await runner._run_collect_unlocked(req)
    assert cancelled.cancelled is True
    assert finalize_calls == 0


@pytest.mark.asyncio
async def test_stream_entry_skips_persistence_on_interrupted_continuation(monkeypatch):
    """工具续轮被截断：流式出口同样不得把前置说明伪装成成功回复并持久化。"""
    from agent import runner

    async def fake_prepare(req, *, non_streaming):
        return _stub_exec(_StubRunner([
            _sse({"type": "token", "content": "正在核验"}),
            _sse({"type": "tool_done", "name": "shell", "status": "error"}),
            _sse({"type": "_new_round", "next_round": 2}),
        ]))

    finalize_calls = 0

    async def fake_finalize(**kwargs):
        nonlocal finalize_calls
        finalize_calls += 1

    monkeypatch.setattr(runner, "prepare_agent_run", fake_prepare)
    from agent.context import run_finalize
    monkeypatch.setattr(run_finalize, "finalize_run", fake_finalize)

    req = AgentRequest(message="hi", user_id="u1", user_name="coffeiz")
    items = [item async for item in runner._run_stream_unlocked(req)]
    final_kind, final = items[-1]
    assert final_kind == "final"
    assert final.errored is True
    assert final.text == "工具结果已返回，但后续回复没有完成，请重试。"
    assert finalize_calls == 0


@pytest.mark.asyncio
async def test_preparation_sessions_all_closed_before_execution(db, user_a, monkeypatch):
    """AsyncSession 不跨 LLM 等待复用：准备期产生的每个会话都在执行开始前关闭。

    用记录型会话工厂包装 db fixture 注入的 _SessionLocal：任何在消费阶段
    （runner.run 生成器被消费时）新开或未关闭的会话都会让断言失败。
    """
    import app.db.session as _sess
    from agent.context import run_context
    from agent.run import preparation as run_preparation
    from agent.run.preparation import prepare_agent_run
    from agent.run.contract import PreparedExecution

    real_session_local = _sess._SessionLocal
    sessions: list[dict] = []

    def recording_factory():
        real = real_session_local()
        record = {"closed": False}
        sessions.append(record)

        class _Wrapper:
            async def __aenter__(self):
                await real.__aenter__()
                return real

            async def __aexit__(self, *args):
                result = await real.__aexit__(*args)
                record["closed"] = True
                return result

            def __getattr__(self, name):
                return getattr(real, name)

        return _Wrapper()

    async def fake_mcp(user_id, settings, allowed=None):
        return []

    async def fake_capability(tool_names, settings, *, db=None, owner_id=None, query="",
                              user_skill_metadata=None, dynamic_tools=()):
        return None

    @dataclasses.dataclass
    class _StubPrepared:
        anthr_messages: list
        anthr_initial_len: int
        oa_messages: list
        oa_initial_len: int
        rag_context: dict
        stance_to_persist: str | None

    async def fake_prepare_run(**kwargs):
        return _StubPrepared([], 0, [], 0, {}, None)

    class _StubRunner:
        def __init__(self, tool_names, settings, **kwargs):
            self.tool_names = tool_names

        def run(self, *args, **kwargs):
            async def _gen():
                if False:
                    yield ""
            return _gen()

    monkeypatch.setattr(_sess, "_SessionLocal", recording_factory)
    monkeypatch.setattr(run_preparation, "_load_mcp_tools", fake_mcp)
    monkeypatch.setattr(run_preparation, "_capability_context", fake_capability)
    monkeypatch.setattr(run_preparation, "_pin_session_user_skill_metadata", lambda *a, **k: False)
    monkeypatch.setattr(run_preparation, "LLMRunner", _StubRunner)
    monkeypatch.setattr(run_context, "prepare_run", fake_prepare_run)

    exec_ = await prepare_agent_run(
        AgentRequest(message="会话生命周期", user_id=user_a.id, user_name=user_a.username),
        non_streaming=True,
    )
    assert isinstance(exec_, PreparedExecution)
    # 准备期至少两段短事务（主准备 + 工具装配），且全部已关闭
    assert len(sessions) >= 2
    assert all(item["closed"] for item in sessions), "准备期存在未关闭的 AsyncSession"

    # 模拟执行期：消费 runner.run 产出时不得再开新会话
    before = len(sessions)
    gen = exec_.runner.run()
    async for _ in gen:
        pass
    assert len(sessions) == before, "执行期新开了 AsyncSession（跨 LLM 等待复用的回归）"
