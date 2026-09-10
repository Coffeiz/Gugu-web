import asyncio
from types import SimpleNamespace

import pytest

from agent.rag import injection
from agent.rag.diagnostics import record_recall
from agent.rag.observation import progress
from agent.runtime.loopscope_trace import state


@pytest.mark.asyncio
async def test_timeout_span_survives_late_completion(monkeypatch):
    """外层超时立即结束唯一 span，后台完成不得伪造注入成功。"""
    run = state._ScopeRun("run-test", "trace-test", "session-test", "", "web", 0)
    token = state._scope_run.set(run)
    monkeypatch.setattr(state, "_enabled", lambda: True)
    monkeypatch.setattr(injection, "AUTO_RECALL_TIMEOUT_SECONDS", 0.001)
    release = asyncio.Event()
    done = asyncio.Event()

    async def slow_search(*args, **kwargs):
        progress("knowledge", "index_prepare")
        await release.wait()
        record_recall(namespace="knowledge", source_type="all", candidate_count=1,
                      hit_count=1, elapsed_ms=10, fallback_reason=None, index_version="test")
        done.set()
        return {"results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", slow_search)
    try:
        result = await injection.build_automatic_rag_context(SimpleNamespace(user_id="owner", source="web"), "缓存")
        assert not result["injected"]
        assert len(run.spans) == 1
        output = dict(run.spans[0].output)
        assert output["reason"] == "timeout"
        assert output["pending_sources"] == ["knowledge"]
        release.set()
        await asyncio.wait_for(done.wait(), 1)
        assert len(run.spans) == 1
        assert run.spans[0].output == output
    finally:
        release.set()
        await injection.shutdown_background_recall_tasks()
        state._scope_run.reset(token)


@pytest.mark.asyncio
async def test_error_is_not_reported_as_timeout(monkeypatch):
    """快速内部异常不能输出超时边界日志。"""
    async def failed(*args, **kwargs):
        raise ValueError("合成错误")
    monkeypatch.setattr("agent.rag.service.search_knowledge", failed)
    result = await injection.build_automatic_rag_context(SimpleNamespace(user_id="owner", source="web"), "缓存")
    assert result["reason"] == "internal_error"
