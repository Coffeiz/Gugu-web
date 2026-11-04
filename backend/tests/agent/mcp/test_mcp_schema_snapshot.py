"""持久化 MCP schema 快照只保存声明，并拒绝过期配置版本写入。"""
from uuid import uuid4

import pytest

from agent.mcp.manager import McpToolManager
from agent.mcp.models import McpServerConfig, McpToolMeta
from agent.mcp.schema_adapter import build_mcp_tool


@pytest.mark.asyncio
async def test_user_tool_schema_snapshot_roundtrips_without_connection(db, user_a):
    config = McpServerConfig(
        id=uuid4(), user_id=user_a.id, name="demo",
        endpoint="https://mcp.example/rpc",
    )
    manager = McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([config])
    meta = McpToolMeta(
        server_id=config.id, server_name="demo", tool_name="echo",
        prefixed_name="mcp_demo_echo", description_short="回显",
        input_schema={"type": "object", "properties": {"text": {"type": "string"}}},
        provider_description="回显文本",
    )
    tool = build_mcp_tool(meta, manager._make_handler(config.id, meta))

    await manager._write_schema_snapshot(user_a.id, manager._config_digest([config]), [tool])
    snapshot = await manager._read_schema_snapshot(user_a.id)

    assert snapshot.config_digest == manager._config_digest([config])
    assert snapshot.schemas[0]["name"] == "mcp_demo_echo"
    assert "endpoint" not in snapshot.schemas[0]
    assert "credentials" not in snapshot.schemas[0]


@pytest.mark.asyncio
async def test_stale_discovery_cannot_overwrite_newer_configuration(db, user_a):
    old = McpServerConfig(id=uuid4(), user_id=user_a.id, name="old")
    current = McpServerConfig(id=old.id, user_id=user_a.id, name="new")
    manager = McpToolManager()
    manager._iter_enabled_configs = lambda _user_id: _configs([current])
    await manager._write_schema_snapshot(user_a.id, manager._config_digest([old]), [])

    assert await manager._read_schema_snapshot(user_a.id) is None


def test_discovery_without_runtime_for_enabled_server_is_not_successful(user_a):
    config = McpServerConfig(id=uuid4(), user_id=user_a.id, name="demo")
    assert not McpToolManager()._discovery_succeeded(user_a.id, [config])


async def _configs(configs):
    for config in configs:
        yield config
