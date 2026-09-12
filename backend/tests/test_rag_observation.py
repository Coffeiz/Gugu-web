import asyncio
import json
import logging
import os
from types import SimpleNamespace

import pytest

from agent.rag import injection
from agent.rag.diagnostics import record_recall
from agent.rag.observation import await_probe, probe_complete, progress
from agent.runtime.loopscope_trace import state


@pytest.mark.asyncio
async def test_timeout_span_records_probe_phase_and_late_completion(monkeypatch, caplog):
    """外层超时立即结束唯一 span，后台完成不得伪造注入成功。"""
    run = state._ScopeRun("run-test", "trace-test", "session-test", "", "web", 0)
    token = state._scope_run.set(run)
    monkeypatch.setattr(state, "_enabled", lambda: True)
    monkeypatch.setattr(injection, "AUTO_RECALL_TIMEOUT_SECONDS", 0.001)
    release = asyncio.Event()
    done = asyncio.Event()

    async def slow_search(*args, **kwargs):
        progress("knowledge", "index_prepare")
        await await_probe("index_cache_get", release.wait())
        record_recall(namespace="knowledge", source_type="all", candidate_count=1,
                      hit_count=1, elapsed_ms=10, fallback_reason=None, index_version="test")
        probe_complete("completed", cache_hit=True)
        done.set()
        return {"results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", slow_search)
    try:
        with caplog.at_level(logging.INFO, logger="agent.rag.probe"):
            result = await injection.build_automatic_rag_context(SimpleNamespace(user_id="owner", source="web"), "缓存")
            assert not result["injected"]
            assert len(run.spans) == 1
            output = dict(run.spans[0].output)
            assert output["reason"] == "timeout"
            assert output["pending_sources"] == ["knowledge"]
            assert output["probe"]["phase"] == "index_cache_get"
            assert output["probe"]["phase_elapsed_ms"] >= 0
            release.set()
            await asyncio.wait_for(done.wait(), 1)
            assert len(run.spans) == 1
            assert run.spans[0].output == output
            assert output["probe"]["backend_worker_pid"] == os.getpid()
            record = next(record for record in caplog.records
                          if record.name == "agent.rag.probe")
            late_event = json.loads(record.getMessage().removeprefix("RAG_PROBE "))
            assert late_event["event"] == "rag_probe_late_completion"
            assert late_event["backend_worker_pid"] == output["probe"]["backend_worker_pid"]
            assert "elapsed_after_timeout_ms" in late_event
            assert "缓存" not in caplog.text
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
