"""root_cause_name：可见日志显示异常链根因类型，traceback 仍只走 diag（2026-09-18）。

生产 worker 曾把 PendingRollbackError 当失败原因展示，真因（APITimeoutError）
藏在 __cause__ 链里，运维容易误判成 DB 故障。
"""
import pytest

from app.core.errors import root_cause_name


def test_returns_own_name_without_cause():
    assert root_cause_name(ValueError("x")) == "ValueError"


def test_follows_cause_chain_to_root():
    try:
        try:
            raise TimeoutError("read timed out")
        except TimeoutError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as outer:
        assert root_cause_name(outer) == "TimeoutError"


def test_follows_context_chain_and_handles_cycles():
    a = ValueError("a")
    b = RuntimeError("b")
    a.__context__ = b
    b.__context__ = a   # 人造环，验证 seen 集合不死循环
    assert root_cause_name(b) in {"ValueError", "RuntimeError"}


def test_pending_rollback_style_wrapping():
    """对齐生产案例：PendingRollbackError → 根因 APITimeoutError。"""

    class PendingRollbackError(Exception):
        pass

    class APITimeoutError(Exception):
        pass

    root = APITimeoutError("request timed out")
    mid = RuntimeError("branch provider failed")
    mid.__cause__ = root
    wrapped = PendingRollbackError("db session dirty")
    wrapped.__cause__ = mid
    assert root_cause_name(wrapped) == "APITimeoutError"
