"""MCP1-005/006 回归：动态工具快照、用户隔离、调用路由与 server 退避。"""
from __future__ import annotations

from uuid import uuid4

import pytest

from agent.mcp.models import McpServerConfig
from agent.mcp import manager as manager_module
from agent.tools import registry


class FakeMcpClient:
    calls = 0
    list_calls = 0
    listing = {"tools": [{
        "name": "echo",
        "description": "回显文本",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }]}
    call_result = {"content": [{"type": "text", "text": "echo ok"}]}

    def __init__(self, endpoint, headers=None, timeout_seconds=30.0):
        self.endpoint = endpoint

    async def list_tools(self):
        type(self).list_calls += 1
        return type(self).listing

    async def call_tool(self, name, arguments):
        type(self).calls += 1
        assert name == "echo"
        assert arguments == {"text": "hello"}
        return type(self).call_result


@pytest.fixture
def enabled_mcp(monkeypatch):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.mcp, "enabled", True)
    monkeypatch.setattr(settings.mcp, "failure_threshold", 2)
    FakeMcpClient.calls = 0
    FakeMcpClient.list_calls = 0
    monkeypatch.setattr(manager_module, "McpClient", FakeMcpClient)
    return settings


def _config(user_id, *, name="demo", confirm_mode="auto"):
    return McpServerConfig(
        id=uuid4(), user_id=user_id, name=name,
        endpoint="https://mcp.example.com/rpc", confirm_mode=confirm_mode,
    )


async def _configs(configs):
    for config in configs:
        yield config


@pytest.mark.asyncio
async def test_dynamic_snapshot_is_run_local(enabled_mcp):
    user_id = uuid4()
    config = _config(user_id)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    tools = await manager.list_user_tools(user_id)
    assert [tool.name for tool in tools] == ["mcp_demo_echo"]
    assert registry.get("mcp_demo_echo") is None

    snapshot = registry.snapshot_with_extras(tools)
    assert snapshot.get("mcp_demo_echo") is not None
    assert snapshot.openai_schemas(["mcp_demo_echo"])[0]["function"]["name"] == "mcp_demo_echo"


@pytest.mark.asyncio
async def test_dispatch_routes_to_mcp_and_keeps_users_isolated(enabled_mcp):
    user_a = uuid4()
    user_b = uuid4()
    config = _config(user_a)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    await manager.list_user_tools(user_a)
    result, artifact = await manager.dispatch(user_a, "mcp_demo_echo", {"text": "hello"})
    assert artifact is None
    assert "echo ok" in result
    assert FakeMcpClient.calls == 1

    denied, _ = await manager.dispatch(user_b, "mcp_demo_echo", {"text": "hello"})
    assert "未知工具" in denied
    assert FakeMcpClient.calls == 1


@pytest.mark.asyncio
async def test_failed_server_enters_backoff_and_is_not_recalled(enabled_mcp):
    user_id = uuid4()
    config = _config(user_id)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    class DeadClient(FakeMcpClient):
        async def list_tools(self):
            type(self).list_calls += 1
            return {"error": "无法连接 MCP server，请检查地址与网络", "error_kind": "network"}

    manager_module.McpClient = DeadClient
    assert await manager.list_user_tools(user_id) == []
    assert await manager.list_user_tools(user_id) == []
    assert await manager.list_user_tools(user_id) == []
    assert DeadClient.list_calls == 2
    assert manager.server_states(user_id)[0]["state"] == "backoff"
