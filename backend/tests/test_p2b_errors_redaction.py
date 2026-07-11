"""P2-b 地基：三个异常基类 + 脱敏/受限诊断出口。

对应 docs/refactor/P2b-错误处理规则.md §2/§3/§5、§7 步骤 1-2。
"""
from __future__ import annotations

import logging

import pytest

from app.core.errors import AppError, ExpectedError, RetryableError
from app.core.redaction import diag_log, diag_log_raw, redact


# ── 异常基类 ──────────────────────────────────────────────────────────────────

def test_expected_error_carries_code_and_public_message():
    e = ExpectedError("file.not_found", "文件不存在")
    assert e.code == "file.not_found"
    assert e.public_message == "文件不存在"
    assert e.cause is None
    assert str(e) == "[file.not_found] 文件不存在"
    assert isinstance(e, AppError)


def test_retryable_error_carries_cause_and_attempt():
    inner = TimeoutError("upstream timed out")
    e = RetryableError("oss.timeout", "存储服务超时", cause=inner, attempt=3)
    assert e.cause is inner
    assert e.attempt == 3
    assert isinstance(e, AppError)


def test_expected_and_retryable_are_distinct_appError_subclasses():
    """路由/主循环要能用 except ExpectedError / except RetryableError 分开处理，
    两者不能是同一个类的两个实例——否则 `except ExpectedError` 会误吞 RetryableError。"""
    assert not issubclass(RetryableError, ExpectedError)
    assert not issubclass(ExpectedError, RetryableError)


def test_public_message_does_not_require_cause():
    """ExpectedError 常见用法：没有上游异常，纯业务判断产生的失败。"""
    e = ExpectedError("perm.denied", "权限不足")
    assert e.cause is None


# ── redact()：跟原 sanitize_error 行为对齐（迁移前后不能变严格度）──────────────

@pytest.mark.parametrize("raw,must_not_contain", [
    ("postgresql://user:pw@host:5432/db", "pw"),
    ("redis://:secret@127.0.0.1:6379/0", "secret"),
    ("sk-abcdefghijklmnop1234567890", "abcdefghijklmnop"),
    ("Authorization: Bearer abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"),
    ("/Users/alice/uploads/secret_report.pdf", "alice"),
    ("/home/coffeiz/.agent/staging/x", "coffeiz"),
    ("user_id=12345678-1234-1234-1234-123456789012", "12345678-1234-1234-1234-123456789012"),
])
def test_redact_strips_sensitive_patterns(raw, must_not_contain):
    assert must_not_contain not in redact(raw)


def test_redact_strips_traceback_frames():
    tb = 'Traceback (most recent call last):\n  File "/app/foo.py", line 12, in bar\n    raise ValueError\nValueError: boom'
    out = redact(tb)
    assert "File \"" not in out
    assert "line 12" not in out


def test_redact_passes_through_normal_text():
    assert redact("文件不存在") == "文件不存在"


def test_redact_handles_none_and_non_string():
    assert redact("") == ""
    assert redact(None) is None   # type: ignore[arg-type]


# ── 受限诊断出口：不进 root logger（因此不进 gugu.log/SystemLog/Debug 面板）─────

def test_diag_logger_does_not_propagate_to_root():
    """这是整个受限出口设计的核心不变量：diag logger 必须 propagate=False，
    否则 app.core.logging.setup_logging() 挂在 root 上的 DbLogHandler/控制台 handler
    会接住它，原始异常就会经由 gugu.log/SystemLog 泄露到 Debug 面板——正是本规则要堵的洞。"""
    diag_logger = logging.getLogger("gugu.diag")
    assert diag_logger.propagate is False


class _CollectingHandler(logging.Handler):
    """自建 root handler 收集实际派发到 root 的记录——不用 pytest 的 caplog。
    caplog 在这个项目里对「模块级 import 时机」敏感（会重复捕获，具体机制没深挖，
    疑似 pytest 的 LogCaptureHandler 在某些收集时序下绕过了 propagate=False 的判断；
    不是本测试要验证的东西），换一个不依赖 pytest 内部实现的独立观察点，规避这个环境噪声，
    直接验真正的生产不变量：gugu.diag 的记录不会走到 root 的 handler 列表里。"""
    def __init__(self):
        super().__init__()
        self.records: list[str] = []

    def emit(self, record):
        self.records.append(self.format(record))


def _with_root_handler():
    handler = _CollectingHandler()
    root = logging.getLogger()
    root.addHandler(handler)
    return handler, lambda: root.removeHandler(handler)


def test_diag_log_writes_raw_exception_to_file_not_root_handlers():
    """diag_log 写原始异常全文，但不能被挂在 root 上的任意 handler 收到——
    验证它真的没有经过 root 的 handler 链（gugu.diag 是 propagate=False）。"""
    handler, cleanup = _with_root_handler()
    try:
        try:
            raise KeyError("super_secret_internal_detail_xyz")
        except KeyError as e:
            diag_log("test.boundary", e)
        assert not any("super_secret_internal_detail_xyz" in r for r in handler.records)
    finally:
        cleanup()

    from app.core.redaction import _diag_dir  # noqa: PLC0415 内部细节，测试专用
    log_path = _diag_dir / "gugu-diag.log"
    assert log_path.exists()
    content = log_path.read_text(encoding="utf-8")
    assert "test.boundary" in content
    assert "KeyError" in content
    assert "super_secret_internal_detail_xyz" in content


def test_diag_log_raw_writes_string_not_exception():
    handler, cleanup = _with_root_handler()
    try:
        diag_log_raw("test.raw_boundary", "raw_marker_abc123")
        assert not any("raw_marker_abc123" in r for r in handler.records)
    finally:
        cleanup()

    from app.core.redaction import _diag_dir  # noqa: PLC0415
    content = (_diag_dir / "gugu-diag.log").read_text(encoding="utf-8")
    assert "test.raw_boundary" in content
    assert "raw_marker_abc123" in content
