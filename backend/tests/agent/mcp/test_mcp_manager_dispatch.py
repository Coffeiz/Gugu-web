"""MCP1-005/006 回归：动态工具快照、用户隔离、调用路由与 server 退避。"""
from __future__ import annotations

import asyncio
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
    async def no_snapshot(_self, _user_id):
        return None

    async def ignore_snapshot(_self, _user_id, _digest, _tools):
        return None

    monkeypatch.setattr(manager_module.McpToolManager, "_read_schema_snapshot", no_snapshot)
    monkeypatch.setattr(manager_module.McpToolManager, "_write_schema_snapshot", ignore_snapshot)
    return settings


def _config(user_id, *, name="demo", confirm_mode="auto"):
    return McpServerConfig(
        id=uuid4(), user_id=user_id, name=name,
        endpoint="https://mcp.example.com/rpc", confirm_mode=confirm_mode,
    )


def test_connection_error_details_only_marks_transient_failures_retryable():
    from agent.mcp.manager import _ServerRuntime, connection_error_details

    runtime = _ServerRuntime(config=_config(uuid4()))
    runtime.last_error_kind = "configuration"
    configuration = connection_error_details(runtime)
    assert configuration["retryable"] is False
    assert "修正" in configuration["next_action"]

    runtime.last_error_kind = "timeout"
    timeout = connection_error_details(runtime)
    assert timeout["retryable"] is True
    assert "重试" in timeout["next_action"]


async def _configs(configs):
    for config in configs:
        yield config


async def _one_config(config):
    return config


@pytest.mark.asyncio
async def test_concurrent_runtime_requests_share_one_mcp_connection(monkeypatch):
    """页面状态探测与 Agent 同时需要同一 server 时，不重复连接和拉取工具。"""
    manager = manager_module.McpToolManager()
    config = _config(uuid4())
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def load_runtime(_settings, requested_config):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        runtime = manager_module._ServerRuntime(config=requested_config)
        manager._runtimes[(manager._user_key(config.user_id), config.id)] = runtime
        return runtime

    monkeypatch.setattr(manager, "_load_runtime", load_runtime)
    first = asyncio.create_task(manager._ensure_runtime(object(), config))
    await started.wait()
    second = asyncio.create_task(manager._ensure_runtime(object(), config))
    await asyncio.sleep(0)

    assert calls == 1
    release.set()
    first_runtime, second_runtime = await asyncio.gather(first, second)

    assert first_runtime is second_runtime
    assert calls == 1


@pytest.mark.asyncio
async def test_enabled_mcp_servers_are_discovered_concurrently(monkeypatch, enabled_mcp):
    """独立 MCP server 的冷发现并发启动，避免总等待时间按 server 数相加。"""
    user_id = uuid4()
    configs = [_config(user_id, name=f"server_{index}") for index in range(2)]
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs(configs)
    active = 0
    peak = 0
    both_started = asyncio.Event()

    async def ensure_runtime(_settings, config):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if peak == len(configs):
            both_started.set()
        try:
            await asyncio.wait_for(both_started.wait(), timeout=1)
            return manager_module._ServerRuntime(config=config)
        finally:
            active -= 1

    monkeypatch.setattr(manager, "_ensure_runtime", ensure_runtime)

    assert await manager.list_user_tools(user_id) == []
    assert peak == 2


@pytest.mark.asyncio
async def test_matching_database_snapshot_skips_mcp_discovery(monkeypatch, enabled_mcp):
    """可用快照命中时不连接 MCP；模型仍拿到相同的规范化工具声明。"""
    user_id = uuid4()
    config = _config(user_id)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])
    digest = manager._config_digest([config])
    async def read_snapshot(_uid):
        return _snapshot(digest, [{
            "name": "mcp_demo_echo", "description": "回显文本",
            "description_short": "回显文本",
            "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}},
            "server_id": str(config.id), "server_name": "demo", "tool_name": "echo",
        }])

    monkeypatch.setattr(manager, "_read_schema_snapshot", read_snapshot)

    async def fail_discovery(*_args, **_kwargs):
        raise AssertionError("快照命中时不应连接 MCP")

    async def _write(*_args):
        raise AssertionError("快照命中时不应重写数据库")

    monkeypatch.setattr(manager, "_discover_user_tools", fail_discovery)
    monkeypatch.setattr(manager, "_write_schema_snapshot", _write)
    tools = await manager.list_user_tools(user_id)

    assert [tool.name for tool in tools] == ["mcp_demo_echo"]
    assert tools[0].input_schema["properties"]["text"]["type"] == "string"


def _snapshot(digest, schemas):
    from types import SimpleNamespace

    return SimpleNamespace(config_digest=digest, schemas=schemas)


@pytest.mark.asyncio
async def test_server_tool_limit_rejects_loading_instead_of_truncating(enabled_mcp, monkeypatch):
    user_id = uuid4()
    config = _config(user_id)

    class TooManyClient(FakeMcpClient):
        listing = {"tools": [
            {"name": f"tool_{index}", "inputSchema": {"type": "object"}}
            for index in range(65)
        ]}

    monkeypatch.setattr(manager_module, "McpClient", TooManyClient)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    assert await manager.list_user_tools(user_id) == []
    state = manager.server_states(user_id)[0]
    assert state["state"] == "error"
    assert "超出单个 server 上限" in state["last_error"]


@pytest.mark.asyncio
async def test_allowlist_is_applied_before_server_tool_limit(enabled_mcp, monkeypatch):
    user_id = uuid4()
    config = _config(user_id)
    config.tool_allowlist = ["tool_32"]

    class TooManyClient(FakeMcpClient):
        listing = {"tools": [
            {"name": f"tool_{index}", "inputSchema": {"type": "object"}}
            for index in range(65)
        ]}

    monkeypatch.setattr(manager_module, "McpClient", TooManyClient)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    tools = await manager.list_user_tools(user_id)
    assert [tool.name for tool in tools] == ["mcp_demo_tool_32"]


@pytest.mark.asyncio
async def test_user_tools_have_no_separate_total_limit(enabled_mcp, monkeypatch):
    user_id = uuid4()
    configs = [_config(user_id, name=f"server_{index}") for index in range(3)]

    class ManyToolsClient(FakeMcpClient):
        listing = {"tools": [
            {"name": f"tool_{index}", "inputSchema": {"type": "object"}}
            for index in range(64)
        ]}

    monkeypatch.setattr(manager_module, "McpClient", ManyToolsClient)
    monkeypatch.setattr(enabled_mcp.mcp, "max_tools_per_server", 64)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs(configs)

    tools = await manager.list_user_tools(user_id)

    assert len(tools) == 3 * 64
    assert tools[-1].name == "mcp_server_2_tool_63"


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
    manager._load_enabled_config = lambda _user_id, _server_id: _one_config(config)

    await manager.list_user_tools(user_a)
    result, artifact = await manager.dispatch(user_a, "mcp_demo_echo", {"text": "hello"})
    assert artifact is None
    assert "echo ok" in result
    assert FakeMcpClient.calls == 1

    denied, _ = await manager.dispatch(user_b, "mcp_demo_echo", {"text": "hello"})
    assert "未知工具" in denied
    assert FakeMcpClient.calls == 1


@pytest.mark.asyncio
async def test_failed_server_enters_backoff_and_is_not_recalled(enabled_mcp, monkeypatch):
    user_id = uuid4()
    config = _config(user_id)
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    class DeadClient(FakeMcpClient):
        async def list_tools(self):
            type(self).list_calls += 1
            return {"error": "无法连接 MCP server，请检查地址与网络", "error_kind": "network"}

    monkeypatch.setattr(manager_module, "McpClient", DeadClient)
    assert await manager.list_user_tools(user_id) == []
    assert await manager.list_user_tools(user_id) == []
    assert await manager.list_user_tools(user_id) == []
    assert DeadClient.list_calls == 2
    assert manager.server_states(user_id)[0]["state"] == "backoff"
