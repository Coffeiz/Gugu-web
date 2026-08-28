import asyncio

import pytest

from agent.terminal.pty_manager import PtyLaunchSpec, PtyManager
from agent.terminal.sandbox_bridge import SandboxPtyBridge, SandboxPtyPolicy


class FakePty:
    def __init__(self):
        self.pid = 321
        self.sandbox_id = "sandbox-test"
        self.writes = []
        self.resizes = []
        self.signals = []
        self.closed = []
        self.output_queue = asyncio.Queue()

    async def write(self, data):
        self.writes.append(data)

    async def resize(self, cols, rows):
        self.resizes.append((cols, rows))

    async def signal(self, signal_name):
        self.signals.append(signal_name)

    async def close(self, *, force=False):
        self.closed.append(force)

    async def output(self):
        while True:
            value = await self.output_queue.get()
            if value is None:
                return
            yield value


class FakeBridge:
    def __init__(self):
        self.handles = []

    async def open(self, spec):
        handle = FakePty()
        self.handles.append((spec, handle))
        return handle


def spec(terminal_id="term-test"):
    return PtyLaunchSpec(terminal_id, "/tmp/user", "sandbox", "none")


@pytest.mark.asyncio
async def test_manager_forwards_input_resize_and_signal_only_when_attached():
    bridge = FakeBridge()
    manager = PtyManager(bridge, detached_ttl_seconds=10)
    session = await manager.start(spec())

    with pytest.raises(RuntimeError, match="活动连接"):
        await manager.write("term-test", b"pwd\n")

    await manager.attach("term-test")
    await manager.write("term-test", b"pwd\n")
    await manager.resize("term-test", 140, 40)
    await manager.signal("term-test", "SIGINT")
    assert manager.snapshots()[0]["pty_sandbox_id"] == "sandbox-test"

    handle = bridge.handles[0][1]
    assert handle.writes == [b"pwd\n"]
    assert handle.resizes == [(140, 40)]
    assert handle.signals == ["SIGINT"]

    await manager.detach("term-test")
    assert session.detached_at is not None


@pytest.mark.asyncio
async def test_manager_reaps_detached_pty_and_forces_close():
    bridge = FakeBridge()
    manager = PtyManager(bridge, detached_ttl_seconds=5)
    await manager.start(spec())
    await manager.attach("term-test")
    await manager.detach("term-test")
    detached_at = manager.get("term-test").detached_at

    assert await manager.reap_detached(now=detached_at + 4) == []
    assert await manager.reap_detached(now=detached_at + 5) == ["term-test"]
    assert bridge.handles[0][1].closed == [True]
    assert manager.get("term-test") is None


@pytest.mark.asyncio
async def test_manager_closes_pty_when_output_exceeds_session_limit():
    bridge = FakeBridge()
    manager = PtyManager(bridge, max_output_bytes=3, max_output_rate=100)
    await manager.start(spec())
    await manager.attach("term-test")
    queue = await manager.subscribe("term-test")
    handle = bridge.handles[0][1]
    await handle.output_queue.put(b"1234")

    assert await asyncio.wait_for(queue.get(), timeout=1) is None
    assert handle.closed == [True]
    assert manager.get("term-test") is None


@pytest.mark.asyncio
async def test_manager_unsubscribes_disconnected_output_queue():
    bridge = FakeBridge()
    manager = PtyManager(bridge)
    await manager.start(spec())
    queue = await manager.subscribe("term-test")
    await manager.unsubscribe("term-test", queue)
    assert manager.get("term-test").output_queues == set()


@pytest.mark.asyncio
async def test_manager_limits_attached_clients_and_stops_reaper():
    bridge = FakeBridge()
    manager = PtyManager(bridge, max_attached_clients=1, reap_interval_seconds=60)
    await manager.start(spec())
    await manager.attach("term-test")
    with pytest.raises(RuntimeError, match="连接数已达上限"):
        await manager.attach("term-test")

    manager.start_reaper()
    assert manager._reaper_task is not None
    await manager.close_all()
    assert manager._reaper_task is None


def test_sandbox_policy_rejects_unsafe_pty_boundary():
    with pytest.raises(ValueError, match="Docker socket"):
        SandboxPtyBridge(policy=SandboxPtyPolicy(docker_socket_mounted=True))

    with pytest.raises(ValueError, match="宿主机 PTY"):
        SandboxPtyBridge(policy=SandboxPtyPolicy(host_pty_exposed=True))

    with pytest.raises(RuntimeError, match="未启动本机 Shell"):
        asyncio.run(SandboxPtyBridge().open(spec()))


def test_sandbox_bridge_delegates_only_sandbox_pty_to_transport():
    class Transport:
        async def open(self, launch_spec):
            return FakePty()

    bridge = SandboxPtyBridge(Transport())
    handle = asyncio.run(bridge.open(spec()))
    assert handle.sandbox_id == "sandbox-test"

    with pytest.raises(RuntimeError, match="system 范围"):
        asyncio.run(bridge.open(PtyLaunchSpec("term-system", "/tmp/user", "system", "none")))
