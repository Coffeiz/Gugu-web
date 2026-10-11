"""split updater Unix socket RPC 的协议与权限边界。"""

from __future__ import annotations

import asyncio
import json
import stat
import uuid
from pathlib import Path

import pytest

from updater.rpc import UpdaterRpcError, call_rpc, serve_unix


def _socket_path():
    """Unix socket 路径保持短于 macOS 的 AF_UNIX 长度上限。"""
    return f"/tmp/gugu-rpc-{uuid.uuid4().hex[:12]}.sock"


@pytest.mark.asyncio
async def test_rpc_success_dispatches_allowlisted_request_and_restricts_socket(tmp_path):
    socket_path = _socket_path()
    received = []

    async def dispatch(request):
        received.append(request)
        return {"mode": "split_compose", "enabled": True}

    server = await serve_unix(str(socket_path), dispatch)
    try:
        assert stat.S_IMODE(Path(socket_path).stat().st_mode) == 0o660
        result = await call_rpc("status", {"include_history": False}, socket_path=socket_path)
    finally:
        server.close()
        await server.wait_closed()
        Path(socket_path).unlink(missing_ok=True)

    assert result == {"mode": "split_compose", "enabled": True}
    assert received == [{"method": "status", "params": {"include_history": False}}]


@pytest.mark.asyncio
async def test_rpc_rejects_non_allowlisted_method_before_connecting(tmp_path):
    with pytest.raises(UpdaterRpcError) as exc_info:
        await call_rpc("exec", {}, socket_path=str(tmp_path / "missing.sock"))

    assert exc_info.value.code == "invalid_request"


@pytest.mark.asyncio
async def test_rpc_unavailable_socket_returns_safe_error(tmp_path):
    with pytest.raises(UpdaterRpcError) as exc_info:
        await call_rpc("status", {}, socket_path=str(tmp_path / "missing.sock"))

    assert exc_info.value.code == "updater_unavailable"
    assert "分体更新服务" in str(exc_info.value)


@pytest.mark.asyncio
async def test_rpc_rejects_non_socket_path_without_overwriting_file(tmp_path):
    socket_path = tmp_path / "occupied"
    socket_path.write_text("user data", encoding="utf-8")

    async def dispatch(_request):
        return {}

    with pytest.raises(RuntimeError, match="非 socket 文件"):
        await serve_unix(str(socket_path), dispatch)

    assert socket_path.read_text(encoding="utf-8") == "user data"


@pytest.mark.asyncio
async def test_rpc_server_rejects_malformed_request_without_dispatching(tmp_path):
    socket_path = _socket_path()
    dispatched = False

    async def dispatch(_request):
        nonlocal dispatched
        dispatched = True
        return {"unexpected": True}

    server = await serve_unix(str(socket_path), dispatch)
    try:
        reader, writer = await asyncio.open_unix_connection(socket_path)
        writer.write(json.dumps({"method": "exec", "params": {}}).encode() + b"\n")
        await writer.drain()
        response = json.loads(await reader.readline())
        writer.close()
        await writer.wait_closed()
    finally:
        server.close()
        await server.wait_closed()
        Path(socket_path).unlink(missing_ok=True)

    assert dispatched is False
    assert response["error"]["code"] == "invalid_request"
