"""LoopScope 跨进程 trace 恢复回归测试。"""

from agent.runtime.loopscope_trace import state


def test_restore_trace_recreates_pending_run(monkeypatch):
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    token = state._scope_run.set(None)
    try:
        trace_id = state.restore_trace("qq-trace")
        run = state._scope_run.get()
        assert trace_id == "qq-trace"
        assert run is not None
        assert run.trace_id == "qq-trace"
        assert run.session_key == "pending:qq-trace"
        assert run.source == "unknown"
    finally:
        state._scope_run.reset(token)
