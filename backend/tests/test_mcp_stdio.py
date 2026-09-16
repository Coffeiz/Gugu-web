"""MCP1-009 验收：stdio 只能经 sandboxd 转发，并保持 JSON-RPC 往返。"""
from __future__ import annotations

import asyncio
import base64
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from agent.mcp.stdio_client import McpStdioClient
from agent.mcp.models import McpServerConfig, McpToolMeta
from agent.mcp.manager import McpToolManager, _ServerRuntime
from agent.sandbox.stdio import SandboxdStdioClient, SandboxdStdioUnavailable


def _frame(value: dict) -> bytes:
    payload = (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8")
    return json.dumps({
        "type": "output", "data": base64.b64encode(payload).decode("ascii"),
    }).encode("utf-8") + b"\n"


@pytest.mark.asyncio
async def test_stdio_client_round_trips_through_sandboxd_socket(tmp_path, monkeypatch):
    socket_path = f"/tmp/gugu-mcp-stdio-{uuid4().hex}.sock"
    root = tmp_path / "user-data"
    root.mkdir()
    received: list[dict] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        opening = json.loads((await reader.readline()).decode("utf-8"))
        received.append(opening)
        writer.write(b'{"type":"ready","pid":123,"sandbox_id":"sandbox-1"}\n')
        await writer.drain()
        while line := await reader.readline():
            control = json.loads(line.decode("utf-8"))
            if control["type"] == "close":
                break
            message = json.loads(base64.b64decode(control["data"], validate=True).decode("utf-8"))
            received.append(message)
            if message.get("id") is None:
                continue
            if message["method"] == "initialize":
                result = {"protocolVersion": "2025-06-18", "capabilities": {}}
            elif message["method"] == "tools/list":
                result = {"tools": [{
                    "name": "echo", "description": "test",
                    "inputSchema": {"type": "object", "properties": {}},
                }]}
            else:
                result = {"content": [{"type": "text", "text": "pong"}], "isError": False}
            writer.write(_frame({"jsonrpc": "2.0", "id": message["id"], "result": result}))
            await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    monkeypatch.setattr(
        "agent.mcp.stdio_client.get_settings",
        lambda: SimpleNamespace(sandbox=SimpleNamespace(sandboxd_socket=str(socket_path))),
    )
    try:
        client = McpStdioClient("python3 server.py", root=str(root), timeout_seconds=1)
        listing = await client.list_tools()
        assert [tool["name"] for tool in listing["tools"]] == ["echo"]
        result = await client.call_tool("echo", {})
        assert result["content"][0]["text"] == "pong"
        assert received[0] == {
            "operation": "stdio_open", "root": str(root), "command": "python3 server.py",
            "cwd": ".", "timeout": 1.0, "network_profile": "none",
        }
        assert any(item.get("method") == "notifications/initialized" for item in received)
    finally:
        await client.aclose()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_sandboxd_stdio_open_rejects_missing_socket():
    client = SandboxdStdioClient("/definitely/missing/sandboxd.sock", connect_timeout=0.01)
    with pytest.raises(SandboxdStdioUnavailable, match="sandboxd stdio 不可用"):
        await client.open(root="/tmp", command="python3 server.py")


def test_stdio_container_has_no_tty_and_keeps_sandbox_boundary(tmp_path):
    from agent.sandbox.docker import DockerSandboxExecutor

    settings = SimpleNamespace(
        image="debian:bookworm-slim", image_digest="sha256:" + "a" * 64,
        network_profile="none", pids_limit=64, cpu_limit=1,
        memory_limit_bytes=128 * 1024 * 1024, ephemeral_quota_bytes=128 * 1024 * 1024,
        egress_proxy_url="", egress_isolation_enabled=False,
    )
    argv = DockerSandboxExecutor(
        tmp_path, settings, docker_path="/usr/bin/docker",
    ).build_stdio_argv("python3 server.py", network_profile="none")
    assert "--interactive" in argv
    assert "--tty" not in argv
    assert "--network=none" in argv
    assert "--read-only" in argv
    assert "--cap-drop=ALL" in argv
    assert "--user=65532:65532" in argv


@pytest.mark.asyncio
async def test_stdio_session_reconnect_is_retained_after_idle_recycle(monkeypatch):
    user_id = uuid4()
    server_id = uuid4()
    config = McpServerConfig(
        id=server_id, user_id=user_id, name="demo", transport="stdio",
        command="python3 server.py", confirm_mode="auto",
    )
    meta = McpToolMeta(
        server_id=server_id, server_name="demo", tool_name="echo",
        prefixed_name="mcp_demo_echo", description_short="echo",
        input_schema={"type": "object", "properties": {}},
    )

    class FakeSession:
        async def call_tool(self, name, arguments):
            assert name == "echo"
            return {"content": [{"type": "text", "text": "pong"}]}

        async def aclose(self):
            pass

    manager = McpToolManager()
    runtime = _ServerRuntime(
        config=config, tools={"mcp_demo_echo": object()},
        metas={"mcp_demo_echo": meta}, client=None,
    )
    session = FakeSession()

    async def new_client(_config, _settings):
        return session

    monkeypatch.setattr(manager, "_new_client", new_client)
    result = await manager._call_server(runtime, config, "mcp_demo_echo", {})
    assert result["content"][0]["text"] == "pong"
    assert runtime.client is session
