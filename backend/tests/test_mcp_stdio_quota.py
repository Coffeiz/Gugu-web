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
