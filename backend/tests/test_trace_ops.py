"""全链路 trace + 运维指标（P0-4）单元测试。

Redis 依赖的聚合读写不在此测（best-effort 旁路、异常自吞），测的是纯逻辑契约：
trace 生成/接力/隔离、延迟分桶、工具轨迹日志带 trace 字段。
"""
import json
import logging
import time

from agent import trace
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


def test_bucket_edges():
    assert opsmetrics._bucket(0) == "50"
    assert opsmetrics._bucket(50) == "50"
    assert opsmetrics._bucket(51) == "100"
    assert opsmetrics._bucket(30000) == "30000"
    assert opsmetrics._bucket(30001) == "inf"


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
