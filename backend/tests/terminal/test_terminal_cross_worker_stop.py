from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.sandbox.client import SandboxdClient


@pytest.mark.asyncio
async def test_stop_request_reaches_shared_sandboxd_without_local_worker_pty(tmp_path, monkeypatch):
    """停止请求落到没有本地 PTY 的 worker 时，仍须让共享 sandboxd 终止容器。"""
    from agent.sandbox import sandboxd

    monkeypatch.chdir(tmp_path)
    socket_path = "sandboxd.sock"
    container_name = "gugu-pty-" + "b" * 32
    removed: list[str] = []
    monkeypatch.setattr(sandboxd, "get_settings", lambda: SimpleNamespace(
        sandbox=SimpleNamespace(manager_mode="disabled", stdio_max_sessions=4,
                                 stdio_max_sessions_per_user=4),
    ))
    monkeypatch.setattr(
        sandboxd, "force_remove_pty_container",
        lambda name: removed.append(name) or True,
    )
    server_instance = sandboxd.SandboxdServer(socket_path, tmp_path)
    monkeypatch.setattr(server_instance, "_validate_peer", lambda _writer: None)
    server = await asyncio.start_unix_server(server_instance.handle, path=str(socket_path))
    try:
        # 这个 client 等价于没有 PTY 所属 worker 内存状态的另一个 Uvicorn worker。
        client = SandboxdClient(str(socket_path))
        assert await client.terminate_pty(container_name) is True
        assert removed == [container_name]
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_cross_worker_stop_ab_old_local_only_vs_shared_sandboxd(tmp_path, monkeypatch):
    """A/B 验证：旧 worker 本地查无 PTY 时 shell 仍执行；共享终止后不再执行。"""
    from agent.sandbox import sandboxd

    monkeypatch.chdir(tmp_path)
    container_name = "gugu-pty-" + "e" * 32
    shell = {"alive": True}
    monkeypatch.setattr(sandboxd, "get_settings", lambda: SimpleNamespace(
        sandbox=SimpleNamespace(manager_mode="disabled", stdio_max_sessions=4,
                                 stdio_max_sessions_per_user=4),
    ))

    def remove_container(name):
        assert name == container_name
        shell["alive"] = False
        return True

    def run_shell_command():
        # 只返回 shell 计算结果，避免把 PTY 对输入命令的回显当成执行证据。
        return "423" if shell["alive"] else None

    monkeypatch.setattr(sandboxd, "force_remove_pty_container", remove_container)
    server_instance = sandboxd.SandboxdServer("sandboxd.sock", tmp_path)
    monkeypatch.setattr(server_instance, "_validate_peer", lambda _writer: None)
    server = await asyncio.start_unix_server(server_instance.handle, path="sandboxd.sock")
    try:
        # A：旧逻辑只看当前 worker 的内存；另一个 worker 查无 PTY，因此不会停止 shell。
        legacy_worker_has_session = False
        if legacy_worker_has_session:
            shell["alive"] = False
        assert run_shell_command() == "423"

        # B：修复后通过共享 sandboxd 按持久化容器标识停止，不依赖本地 manager。
        client = SandboxdClient("sandboxd.sock")
        assert await client.terminate_pty(container_name) is True
        assert run_shell_command() is None
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_terminate_api_uses_shared_sandboxd_when_local_manager_has_no_session(monkeypatch):
    """HTTP 停止即使命中其他 worker，也按数据库保存的 sandbox id 发出关闭请求。"""
    from app.api.v1 import terminals

    row = SimpleNamespace(
        id="terminal-test", owner_id="owner-test", session_id=None,
        mode="interactive-pty", pty_sandbox_id="gugu-pty-" + "c" * 32,
    )
    calls: list[str] = []

    class Db:
        async def commit(self):
            return None

    class Manager:
        def get(self, terminal_id):
            return None

    class Client:
        def __init__(self, socket_path):
            assert socket_path == "/tmp/test-sandboxd.sock"

        async def terminate_pty(self, container_name):
            calls.append(container_name)
            return True

    async def authorized(*args, **kwargs):
        return SimpleNamespace(allowed=True)

    async def terminate_record(_db, target):
        target.status = "terminated"

    async def publish(*args, **kwargs):
        return None

    monkeypatch.setattr(terminals, "get_terminal", lambda *_args: _async_value(row))
    monkeypatch.setattr(terminals, "authorize_operation", authorized)
    monkeypatch.setattr(terminals, "terminate_terminal_record", terminate_record)
    monkeypatch.setattr(terminals, "get_pty_manager", lambda: Manager())
    monkeypatch.setattr(terminals, "SandboxdClient", Client)
    monkeypatch.setattr(terminals, "serialize_terminal", lambda target: {
        "id": target.id, "status": target.status,
    })
    monkeypatch.setattr(terminals, "get_settings", lambda: SimpleNamespace(
        sandbox=SimpleNamespace(sandboxd_socket="/tmp/test-sandboxd.sock"),
    ))
    monkeypatch.setattr(terminals.events, "publish", publish)

    result = await terminals.terminate_terminal_view(
        "terminal-test", user=SimpleNamespace(id="owner-test"), db=Db(), request=None,
    )

    assert calls == [row.pty_sandbox_id]
    assert row.status == "terminated"
    assert result["status"] == "terminated"


async def _async_value(value):
    return value
