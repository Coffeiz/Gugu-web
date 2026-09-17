"""MCP1-006/007 的桩级链路：用户配置 → 动态声明 → 调用结果 → 下一轮可见。"""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest

from agent.core import LLMRunner
from agent.mcp import manager as manager_module
from agent.mcp.models import McpServerConfig


class EchoClient:
    async def list_tools(self):
        return {
            "tools": [{
                "name": "echo",
                "description": "回显内容\n参数 text 会原样返回。\n请按厂商提供的完整说明调用。",
                "inputSchema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
            }],
        }

    async def call_tool(self, name, arguments):
        assert name == "echo"
        return {"content": [{"type": "text", "text": f"回显：{arguments['text']}"}]}


@pytest.mark.asyncio
async def test_user_config_to_dynamic_declaration_call_and_next_round(monkeypatch):
    settings = SimpleNamespace(
        mcp=SimpleNamespace(
            enabled=True,
            max_tools_per_server=64,
            default_timeout_seconds=30,
            failure_threshold=3,
            backoff_seconds=60,
        ),
        ai=SimpleNamespace(provider="fake", model="fake"),
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    monkeypatch.setattr(manager_module, "McpClient", lambda *args, **kwargs: EchoClient())

    user_id = uuid4()
    config = McpServerConfig(
        id=uuid4(), user_id=user_id, name="demo", endpoint="https://mcp.example/rpc",
        confirm_mode="auto",
    )
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    tools = await manager.list_user_tools(user_id)
    assert [tool.name for tool in tools] == ["mcp_demo_echo"]
    assert tools[0].description_short == "回显内容"
    assert tools[0].to_openai()["function"]["description"] == (
        "回显内容\n参数 text 会原样返回。\n请按厂商提供的完整说明调用。"
    )
    assert tools[0].to_anthropic()["description"] == tools[0].to_openai()["function"]["description"]

    # 动态工具只进入本轮派生快照，下一轮按用户重新得到同名声明；全局 registry 不变。
    runner = LLMRunner(["ask_user"], settings, dynamic_tools=tools)
    assert runner._provider_tool_names(["ask_user"]) == ["ask_user", "mcp_demo_echo"]
    result, artifact = await manager.dispatch(user_id, "mcp_demo_echo", {"text": "hello"})
    assert artifact is None
    assert "回显：hello" in result

    next_round_tools = await manager.list_user_tools(user_id)
    assert [tool.name for tool in next_round_tools] == ["mcp_demo_echo"]


@pytest.mark.asyncio
async def test_mcp_disabled_removes_user_tools_from_declaration(monkeypatch):
    settings = SimpleNamespace(
        mcp=SimpleNamespace(enabled=False),
        ai=SimpleNamespace(provider="fake", model="fake"),
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    user_id = uuid4()
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([])
    assert await manager.list_user_tools(user_id) == []
    assert LLMRunner([], settings, dynamic_tools=[])._provider_tool_names([]) == []


@pytest.mark.asyncio
async def test_mcp_tool_without_description_still_enters_dynamic_catalog(monkeypatch):
    settings = SimpleNamespace(
        mcp=SimpleNamespace(
            enabled=True, max_tools_per_server=64,
            default_timeout_seconds=30, failure_threshold=3, backoff_seconds=60,
        ),
        ai=SimpleNamespace(provider="fake", model="fake"),
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    class NoDescriptionClient:
        async def list_tools(self):
            return {
                "tools": [{
                    "name": "echo",
                    "inputSchema": {"type": "object", "properties": {}},
                }],
            }

    monkeypatch.setattr(manager_module, "McpClient", lambda *args, **kwargs: NoDescriptionClient())
    user_id = uuid4()
    config = McpServerConfig(
        id=uuid4(), user_id=user_id, name="gaode", endpoint="https://mcp.example/rpc",
        confirm_mode="auto",
    )
    manager = manager_module.McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])

    tools = await manager.list_user_tools(user_id)
    assert tools[0].description_short
    assert "echo" in tools[0].description_short


def test_dynamic_mcp_tools_use_adapter_in_fixed_adapter_mode():
    from types import SimpleNamespace
    from agent.tools.base import Tool

    dynamic = Tool(
        name="mcp_gaode_geocode",
        description="高德地理编码",
        input_schema={"type": "object", "properties": {"address": {"type": "string"}}},
        handler=lambda _db, _user, _args: None,
    )
    settings = SimpleNamespace(state_labels=SimpleNamespace(overrides={}))
    runner = LLMRunner(
        ["call_tool", "get_tool_schema"], settings,
        capability_context=SimpleNamespace(fixed_adapter=True),
        dynamic_tools=[dynamic],
    )

    assert runner._provider_tool_names(["call_tool", "get_tool_schema"]) == [
        "call_tool", "get_tool_schema",
    ]


def test_dynamic_mcp_tools_remain_native_in_full_schema_mode():
    from agent.tools.base import Tool

    dynamic = Tool(
        name="mcp_gaode_geocode",
        description="高德地理编码",
        input_schema={"type": "object", "properties": {"address": {"type": "string"}}},
        handler=lambda _db, _user, _args: None,
    )
    settings = SimpleNamespace(state_labels=SimpleNamespace(overrides={}))
    runner = LLMRunner(
        ["ask_user"], settings,
        capability_context=SimpleNamespace(fixed_adapter=False, metadata_only=True),
        dynamic_tools=[dynamic],
    )

    assert runner._provider_tool_names(["ask_user"]) == ["ask_user", "mcp_gaode_geocode"]


async def _configs(configs):
    for config in configs:
        yield config
