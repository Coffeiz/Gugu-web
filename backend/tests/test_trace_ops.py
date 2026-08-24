"""全链路 trace + 运维指标（P0-4）单元测试。

Redis 依赖的聚合读写不在此测（best-effort 旁路、异常自吞），测的是纯逻辑契约：
trace 生成/接力/隔离、延迟分桶、工具轨迹日志带 trace 字段。
"""
import asyncio
import json
import logging
import time

import pytest

from agent.runtime.loopscope_trace.state import _ScopeRun, _now, _scope_run
from agent.runtime.loopscope_trace import state as trace_state
from agent.runtime import trace
from app.core import opsmetrics


def test_new_trace_sets_and_returns():
    t = trace.new_trace()
    assert len(t) == 12 and trace.get_trace() == t


def test_set_trace_restores_upstream_id():
    assert trace.set_trace("abc123def456") == "abc123def456"
    assert trace.get_trace() == "abc123def456"


def test_set_trace_generates_when_empty():
    t = trace.set_trace(None)
    assert len(t) == 12
    assert trace.set_trace("  ") != ""   # 空白串也视为缺失、新生成


def test_bind_im_run_assigns_session_metadata(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = trace_state._ScopeRun(
        id="run-bind", trace_id="trace-bind", session_key="pending:trace-bind",
        external_session_id="", source="unknown", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        trace.bind_im_run(388, "qq")
    finally:
        _scope_run.reset(token)

    assert run.session_key == "gugu:qq:388"
    assert run.external_session_id == "388"
    assert run.source == "qq"


def test_record_context_compaction_creates_redacted_span(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-compaction", trace_id="trace-compaction", session_key="gugu:qq:388",
        external_session_id="388", source="qq", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        trace_state.record_context_compaction(
            phase="completed", reason="compacted", changed=True,
            before_messages=256, after_messages=39,
            before_summary_count=0, after_summary_count=1,
            before_summary_chars=0, after_summary_chars=1464,
            protected_from=255,
        )
    finally:
        _scope_run.reset(token)

    span = next(item for item in run.spans if item.name == "Context compaction")
    assert span.status == "success"
    assert span.input["before_messages"] == 256
    assert span.input["after_messages"] == 39
    assert span.input["after_summary_chars"] == 1464
    assert "summary" not in span.input


@pytest.mark.asyncio
async def test_finish_run_closes_non_web_scope_run(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    async def no_op_post(_snapshot):
        return None
    monkeypatch.setattr(trace_state, "_post_snapshot", no_op_post)
    run = _ScopeRun(
        id="run-im-test", trace_id="trace-im-test", session_key="pending:trace-im-test",
        external_session_id="", source="unknown", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        trace.finish_run("success", "测试回复")
    finally:
        _scope_run.reset(token)

    assert run.status == "success"
    assert run.ended_at is not None
    assert run.output_text == "测试回复"
    await asyncio.gather(*list(trace_state._send_tasks), return_exceptions=True)


def test_bucket_edges():
    assert opsmetrics._bucket(0) == "50"
    assert opsmetrics._bucket(50) == "50"
    assert opsmetrics._bucket(51) == "100"
    assert opsmetrics._bucket(30000) == "30000"
    assert opsmetrics._bucket(30001) == "inf"


def test_security_events_defined():
    # 面板依赖这两个 key 恒存在（正常为 0），别随意改名
    assert "ownership.denied" in opsmetrics.SECURITY_EVENTS
    assert "confirm-gate.bypassed" in opsmetrics.SECURITY_EVENTS


def test_record_security_no_loop_is_safe():
    # 无 event loop（同步上下文）时 record_security 必须静默返回、不抛
    opsmetrics.record_security("ownership.denied")


def test_log_traj_carries_trace(caplog):
    from agent.tools.base import _log_traj
    tid = trace.new_trace()
    with caplog.at_level(logging.INFO, logger="agent.traj"):
        _log_traj("test_tool", "user-1234-abcd", {"project_id": 1, "name": "秘密"}, True, "", time.monotonic())
    recs = [r.message for r in caplog.records]
    assert recs, "应有一条轨迹日志"
    rec = json.loads(recs[-1])
    assert rec["trace"] == tid
    assert rec["args"]["name"] == "***"   # 字符串值打码不受影响（回归）
