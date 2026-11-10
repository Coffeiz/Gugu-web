import socket
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

import scripts.wait_for_unix_socket as socket_waiter
from scripts.wait_for_unix_socket import wait_for_unix_socket

BACKEND_ROOT = Path(__file__).resolve().parents[3]


def test_rag_consumers_require_sidecar_and_wait_for_socket_readiness():
    """RAG sidecar 不可用时消费者不应带着失效 socket 启动或声称会回退。"""
    for unit_name in (
        "gugu-backend.service",
        "gugu-worker.service",
        "gugu-gateway.service",
    ):
        unit = (BACKEND_ROOT / unit_name).read_text(encoding="utf-8")
        assert "Requires=gugu-rag-sidecar.service" in unit
        assert "After=gugu-rag-sidecar.service" in unit
        assert "Wants=gugu-rag-sidecar.service" not in unit

    sidecar = (BACKEND_ROOT / "gugu-rag-sidecar.service").read_text(encoding="utf-8")
    assert "ExecStartPost=__APP_DIR__/.venv/bin/python" in sidecar
    assert "scripts/wait_for_unix_socket.py" in sidecar
    assert "--timeout 120" in sidecar
    assert "TimeoutStartSec=130s" in sidecar
    assert "/run/user/__RUN_UID__/gugu-rag-sidecar.sock" in sidecar


def test_sidecar_readiness_waits_for_a_listening_socket_and_rejects_stale_path():
    """残留 socket 路径不能让消费者在监听器启动前误判 sidecar 已就绪。"""
    with tempfile.TemporaryDirectory(prefix="rag-") as temp_dir:
        socket_path = Path(temp_dir) / "r.sock"
        socket_path.touch()
        with pytest.raises(TimeoutError):
            wait_for_unix_socket(str(socket_path), timeout_seconds=0.02)

        socket_path.unlink()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(socket_path))
            listener.listen()
            wait_for_unix_socket(str(socket_path), timeout_seconds=0.2)
        finally:
            listener.close()


def test_sidecar_readiness_waits_through_a_cold_start_longer_than_five_seconds(monkeypatch):
    """模拟首次原生模块编译耗时超过旧 5 秒阈值后，sidecar 才开始监听。"""
    with tempfile.TemporaryDirectory(prefix="rag-") as temp_dir:
        socket_path = Path(temp_dir) / "r.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        clock_seconds = 0.0
        listening = False

        def advance_startup_clock(seconds):
            nonlocal clock_seconds, listening
            clock_seconds += seconds
            if clock_seconds >= 5.1 and not listening:
                listener.bind(str(socket_path))
                listener.listen()
                listening = True

        monkeypatch.setattr(
            socket_waiter,
            "time",
            SimpleNamespace(monotonic=lambda: clock_seconds, sleep=advance_startup_clock),
        )
        try:
            wait_for_unix_socket(str(socket_path), timeout_seconds=120.0)
            assert listening
            assert clock_seconds >= 5.1
        finally:
            listener.close()
