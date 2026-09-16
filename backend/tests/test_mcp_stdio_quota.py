"""PR #72 复审 P1：stdio 长驻会话独立配额、按用户上限与空闲回收。

sandboxd 的全局 execute 槽（Semaphore(4)）不能被长驻 stdio 连接占满；
manager 侧要有真正的后台 idle reaper，而不是只在下次 _ensure_runtime 顺带检查。
"""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest

from agent.mcp import manager as manager_module
from agent.mcp.models import McpServerConfig
from agent.sandbox.sandboxd import SandboxdServer


@pytest.fixture
def server(tmp_path):
    return SandboxdServer(tmp_path / "sandboxd.sock", tmp_path)


@pytest.mark.asyncio
async def test_stdio_per_user_cap_rejects_before_docker(server, tmp_path):
    """同根目录（=同用户）的 stdio 会话数到上限后，新连接在进入 Docker 前即被拒绝。"""
    root = tmp_path
    server._stdio_counts[str(root)] = server._stdio_per_user_limit
    with pytest.raises(ValueError) as exc:
        await server._handle_stdio({"root": str(root), "command": "npx some-mcp"}, None, None)
    assert "上限" in str(exc.value)
    # 计数没有被失败的尝试破坏
    assert server._stdio_counts[str(root)] == server._stdio_per_user_limit


@pytest.mark.asyncio
async def test_stdio_cap_accounting_releases_on_close(server, tmp_path):
    root = tmp_path
    assert str(root) not in server._stdio_counts
    server._stdio_counts[str(root)] = 1
    remaining = server._stdio_counts.get(str(root), 1) - 1
    if remaining > 0:
        server._stdio_counts[str(root)] = remaining
    else:
        server._stdio_counts.pop(str(root), None)
    assert str(root) not in server._stdio_counts


@pytest.mark.asyncio
async def test_reap_idle_stdio_closes_only_idle_and_keeps_tools():
    """空闲超阈值的 stdio 连接被后台回收：客户端关闭、工具缓存保留以便重连。"""
    settings = SimpleNamespace(mcp=SimpleNamespace(stdio_idle_seconds=60))
    manager = manager_module.McpToolManager()

    closed: list[str] = []

    class FakeClient:
        def __init__(self, tag: str):
            self.tag = tag

        async def aclose(self):
            closed.append(self.tag)

    user = uuid4()
    idle_config = McpServerConfig(id=uuid4(), user_id=user, name="idle", transport="stdio", command="x")
    fresh_config = McpServerConfig(id=uuid4(), user_id=user, name="fresh", transport="stdio", command="y")
    idle_rt = manager_module._ServerRuntime(config=idle_config)
    idle_rt.client = FakeClient("idle")
    idle_rt.last_used_at = time.monotonic() - 120
    idle_rt.tools["mcp_idle_x"] = object()
    fresh_rt = manager_module._ServerRuntime(config=fresh_config)
    fresh_rt.client = FakeClient("fresh")
    fresh_rt.last_used_at = time.monotonic()
    manager._runtimes[(user, idle_config.id)] = idle_rt
    manager._runtimes[(user, fresh_config.id)] = fresh_rt

    closed_count = await manager.reap_idle_stdio(settings)

    assert closed_count == 1
    assert closed == ["idle"]
    assert idle_rt.client is None
    assert idle_rt.tools          # 工具声明保留：下次调用自动重连
    assert fresh_rt.client is not None


@pytest.mark.asyncio
async def test_ensure_idle_reaper_starts_once():
    manager = manager_module.McpToolManager()
    manager._ensure_idle_reaper()
    task = manager._idle_reaper_task
    assert task is not None and not task.done()
    manager._ensure_idle_reaper()
    assert manager._idle_reaper_task is task
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_reap_skips_in_flight_even_if_stale():
    """二审 P2：正在外呼的连接即使 last_used_at 已超阈值也绝不可被 reaper 关闭。"""
    settings = SimpleNamespace(mcp=SimpleNamespace(stdio_idle_seconds=60))
    manager = manager_module.McpToolManager()

    class FakeClient:
        async def aclose(self):
            raise AssertionError("in_flight 的连接不应被关闭")

    config = McpServerConfig(id=uuid4(), user_id=uuid4(), name="busy", transport="stdio", command="x")
    runtime = manager_module._ServerRuntime(config=config)
    runtime.client = FakeClient()
    runtime.last_used_at = time.monotonic() - 600
    runtime.in_flight = 1
    manager._runtimes[(config.user_id, config.id)] = runtime

    assert await manager.reap_idle_stdio(settings) == 0
    assert runtime.client is not None


@pytest.mark.asyncio
async def test_call_server_refreshes_last_used_before_awaiting():
    """二审 P2：外呼前先刷新 last_used_at——空闲后第一次调用不再带着旧时间戳
    给 reaper 递刀；调用结束后 in_flight 归零。"""
    manager = manager_module.McpToolManager()
    stale = time.monotonic() - 600
    seen_at_call_time: list[float] = []

    config = McpServerConfig(id=uuid4(), user_id=uuid4(), name="s", transport="stdio", command="x")
    runtime = manager_module._ServerRuntime(config=config)

    class FakeClient:
        async def call_tool(self, name, arguments):
            seen_at_call_time.append(runtime.last_used_at)
            return {"content": [{"type": "text", "text": "ok"}]}

    runtime.client = FakeClient()
    runtime.last_used_at = stale
    runtime.in_flight = 0
    from agent.mcp.models import McpToolMeta
    runtime.metas["mcp_s_echo"] = McpToolMeta(
        server_id=config.id, server_name="s", tool_name="echo", prefixed_name="mcp_s_echo",
        description_short="回显", input_schema={"type": "object", "properties": {}},
    )
    manager._runtimes[(config.user_id, config.id)] = runtime

    result = await manager._call_server(runtime, config, "mcp_s_echo", {"text": "hi"})

    assert "error" not in result
    assert seen_at_call_time and seen_at_call_time[0] > stale  # 外呼时已刷新
    assert runtime.in_flight == 0
    assert runtime.last_used_at >= seen_at_call_time[0]
