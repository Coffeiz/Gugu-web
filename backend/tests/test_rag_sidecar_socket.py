"""PRD sidecar 常驻服务（提交 1）：传输层模板重构 + SocketSidecarClient。

- 模板方法 ``_request``：锁/probe 外壳共享，``_prepare_for_send`` / ``_transact`` /
  ``_absorb_state`` 三个覆写点；基类行为不变（spawn 子进程 + stdio）。
- SocketSidecarClient：unix socket 传输 + 宿主下发 state 镜像回填；
  ``reuse_if_current`` / ``replace_transient`` 短路判定移交宿主。

不启动真实 TS worker / 真实宿主：宿主用进程内 asyncio unix server 模拟。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import agent.rag.ts_sidecar as ts_sidecar
from agent.rag.ts_sidecar import (
    SocketSidecarClient,
    TsSidecarClient,
    TsSidecarUnavailable,
    get_lexical_client,
)


# ── 模板方法：三个覆写点的调用序与状态吸收 ──────────────────────────────


class _RecordingClient(TsSidecarClient):
    """记录覆写点调用序的最小客户端；_transact 返回可配置响应。"""

    def __init__(self):
        super().__init__("owner-x", command="", index_dir="idx")
        self.calls: list[str] = []
        self.next_response: dict = {"revision": "r2", "document_count": 3}
        self.fail_prepare = True

    async def _prepare_for_send(self) -> None:
        self.calls.append("prepare")
        if self.fail_prepare:
            raise TsSidecarUnavailable("no transport")

    async def _transact(self, payload: dict, *, timeout_seconds: float | None = None) -> dict:
        self.calls.append(f"transact:{payload.get('op')}")
        return dict(self.next_response)

    def _absorb_state(self, payload: dict, response: dict) -> dict:
        self.calls.append("absorb")
        return super()._absorb_state(payload, response)


@pytest.mark.asyncio
async def test_template_calls_prepare_transact_absorb_in_order():
    client = _RecordingClient()
    client.fail_prepare = False
    result = await client._request({"op": "replace", "revision": ""})
    assert client.calls == ["prepare", "transact:replace", "absorb"]
    assert result.response["revision"] == "r2"
    # 基类 absorb：持久索引响应回写 revision
    assert client._revision == "r2"


@pytest.mark.asyncio
async def test_template_replace_transient_response_does_not_touch_revision():
    client = _RecordingClient()
    client.fail_prepare = False
    client._revision = "r1"
    client.next_response = {"revision": "transient-stamp"}
    await client._request({"op": "replace_transient", "revision": "transient-stamp"})
    assert client._revision == "r1"   # 瞬态指纹不得覆盖持久 revision（2026-09-11 修）


@pytest.mark.asyncio
async def test_template_prepare_failure_raises_unavailable():
    client = _RecordingClient()
    with pytest.raises(TsSidecarUnavailable):
        await client._request({"op": "ping"})


# ── SocketSidecarClient：信封收发、镜像回填、宿主侧判定 ───────────────────


class FakeHost:
    """进程内模拟 gugu-rag-sidecar 宿主：按 owner 维护状态，按 op 分派。"""

    def __init__(self):
        self.state: dict[str, dict] = {}
        self.forwarded_transient = 0
        self.reuse_calls = 0

    def client_state(self, owner: str) -> dict:
        return self.state.setdefault(owner, {
            "revision": None, "document_count": 0, "estimated_bytes": 0,
            "vector_count": 0, "vector_version": "", "restore_error": None,
            "transient_revision": None, "transient_generation": 3,
            "process_generation": 3,
        })

    async def handle(self, owner: str, payload: dict) -> dict:
        op = payload.get("op")
        state = self.client_state(owner)
        if op == "reuse_if_current":
            self.reuse_calls += 1
            expected = payload.get("revision") or ""
            ok = bool(expected) and state["revision"] == expected
            return {"ok": ok}
        if op == "replace_transient":
            if not payload.get("force") and state["transient_revision"] == payload.get("revision"):
                return {"status": "ok", "revision": payload.get("revision"), "short_circuit": True}
            self.forwarded_transient += 1
            state["transient_revision"] = str(payload.get("revision") or "")
            return {"status": "ok", "revision": str(payload.get("revision") or "")}
        if op == "boom":
            return {"status": "error", "code": "revision_mismatch", "message": "过期"}
        if op == "replace":
            state["revision"] = payload.get("revision") or None
            state["document_count"] = len(payload.get("documents") or [])
            state["estimated_bytes"] = 12345
            return {"status": "ok", "revision": state["revision"],
                    "document_count": state["document_count"]}
        if op == "ping":
            return {"status": "ok"}
        raise AssertionError(f"fake host 未实现的 op: {op}")


@pytest.fixture
async def fake_host_server():
    host = FakeHost()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                envelope = json.loads(line)
                owner = envelope["owner"]
                try:
                    payload = await host.handle(owner, envelope["payload"])
                    if isinstance(payload, dict) and payload.get("status") == "error":
                        # 宿主把 worker 层错误转成信封级 error（与真实宿主一致）
                        raise TsSidecarUnavailable(
                            str(payload.get("message") or "worker error"),
                            code=str(payload.get("code") or "") or None,
                        )
                    response = {"req_id": envelope["req_id"], "payload": payload,
                                "state": host.client_state(owner)}
                except TsSidecarUnavailable as exc:
                    response = {"req_id": envelope["req_id"], "status": "error",
                                "code": exc.code or "host_error", "message": str(exc)}
                writer.write((json.dumps(response) + "\n").encode())
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()

    # AF_UNIX 上限 104 字节，pytest tmp_path 前缀太长，用短路径
    socket_path = Path(f"/tmp/sss-{format(abs(hash(host)) % 0xffffffff, 'x')}.sock")
    socket_path.unlink(missing_ok=True)
    server = await asyncio.start_unix_server(handler, path=str(socket_path))
    try:
        yield host, str(socket_path)
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_socket_client_roundtrip_and_state_mirror(fake_host_server):
    _host, socket_path = fake_host_server
    client = SocketSidecarClient("owner-1", socket_path=socket_path)
    try:
        await client.replace([], "rev-1")
        assert client._revision == "rev-1"
        assert client._document_count == 0
        assert client._estimated_bytes == 12345
        assert client._transient_generation == 3   # 镜像回填，非本进程 0
        assert client._process_generation == 3
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_socket_reuse_if_current_decided_by_host(fake_host_server):
    host, socket_path = fake_host_server
    client = SocketSidecarClient("owner-1", socket_path=socket_path)
    try:
        assert await client.reuse_if_current("rev-1") is False
        await client.replace([], "rev-1")
        assert await client.reuse_if_current("rev-1") is True
        assert host.reuse_calls == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_socket_replace_transient_short_circuit_on_host(fake_host_server):
    host, socket_path = fake_host_server
    client = SocketSidecarClient("owner-1", socket_path=socket_path)
    try:
        # 状态镜像已含 transient_revision=None → 首次必须真转发
        await client.replace_transient([], "mem-1", force=False)
        assert host.forwarded_transient == 1
        # 宿主侧 host.state 未经过镜像同步的 transient 仍为 None；
        # 直接把宿主状态置为已加载，模拟宿主上语料已在
        host.client_state("owner-1")["transient_revision"] = "mem-1"
        await client.replace_transient([], "mem-1", force=False)
        assert host.forwarded_transient == 1   # 宿主短路，不再转发
        # force=True 跳过宿主短路
        await client.replace_transient([], "mem-1", force=True)
        assert host.forwarded_transient == 2
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_socket_error_code_propagates(fake_host_server):
    _host, socket_path = fake_host_server
    client = SocketSidecarClient("owner-1", socket_path=socket_path)
    try:
        with pytest.raises(TsSidecarUnavailable) as exc_info:
            await client._request({"op": "boom"})
        assert exc_info.value.code == "revision_mismatch"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_socket_dead_path_raises_unavailable(tmp_path):
    client = SocketSidecarClient("owner-1", socket_path=str(tmp_path / "missing.sock"))
    with pytest.raises(TsSidecarUnavailable):
        await client._request({"op": "ping"})


# ── 工厂分流：socket 可达走代理、不可达回退 spawn ────────────────────────


@pytest.mark.asyncio
async def test_factory_prefers_socket_when_reachable(fake_host_server, monkeypatch):
    _host, socket_path = fake_host_server
    monkeypatch.setattr(ts_sidecar, "_sidecar_socket_path", lambda: socket_path)
    client = await get_lexical_client("owner-sock", command="", index_dir="idx")
    assert isinstance(client, SocketSidecarClient)
    again = await get_lexical_client("owner-sock", command="", index_dir="idx")
    assert again is client
    await client.close()


@pytest.mark.asyncio
async def test_factory_falls_back_to_spawn_when_socket_missing(monkeypatch):
    monkeypatch.setattr(ts_sidecar, "_sidecar_socket_path", lambda: str(Path("/nonexistent/sidecar.sock")))
    client = await get_lexical_client("owner-fb", command="", index_dir="idx")
    assert type(client) is TsSidecarClient


# ── 宿主（SidecarHost）：真 socket 全链路 + 内层 fake client ─────────────


class FakeInnerClient:
    """宿主内真实 TsSidecarClient 的替身：同样的状态字段与方法面。"""

    def __init__(self):
        self.owner_user_id = "owner-host"
        self._lock = asyncio.Lock()
        self._process = None
        self._revision = None
        self._document_count = 0
        self._estimated_bytes = 0
        self._vector_count = 0
        self._vector_version = ""
        self._restore_error = None
        self._transient_revision = None
        self._transient_generation = -1
        self._process_generation = 2
        self.requests: list[dict] = []
        self.reuse_calls = 0

    def touch(self) -> None:
        pass

    def is_idle(self, now=None) -> bool:
        return False

    async def reuse_if_current(self, revision):
        self.reuse_calls += 1
        return bool(revision) and self._revision == revision

    async def _request(self, payload, *, timeout_seconds=None):
        async with self._lock:
            self.requests.append(payload)
            op = payload.get("op")
            if op == "boom":
                raise TsSidecarUnavailable("过期", code="revision_mismatch")
            if op == "replace":
                self._revision = payload.get("revision") or None
                self._document_count = len(payload.get("documents") or [])
                return ts_sidecar.SidecarRequestResult(
                    response={"status": "ok", "revision": self._revision,
                              "document_count": self._document_count},
                    timing=ts_sidecar.SidecarRequestTiming(),
                )
            if op == "replace_transient":
                self._transient_revision = str(payload.get("revision") or "")
                return ts_sidecar.SidecarRequestResult(
                    response={"status": "ok", "revision": self._transient_revision},
                    timing=ts_sidecar.SidecarRequestTiming(),
                )
            return ts_sidecar.SidecarRequestResult(
                response={"status": "ok"}, timing=ts_sidecar.SidecarRequestTiming(),
            )

    async def close(self) -> None:
        pass


@pytest.fixture
async def running_host(monkeypatch):
    from agent.rag.sidecar_host import SidecarHost

    inner = FakeInnerClient()
    monkeypatch.setattr(SidecarHost, "_client_for", lambda self, owner: inner)
    host = SidecarHost(f"/tmp/sss-host-{format(abs(hash(inner)) % 0xffffffff, 'x')}.sock")
    await host.start()
    try:
        yield host, inner
    finally:
        await host.stop()


@pytest.mark.asyncio
async def test_host_routes_requests_and_exports_state(running_host):
    host, inner = running_host
    client = SocketSidecarClient("owner-host", socket_path=host.socket_path)
    try:
        await client.replace([], "rev-9")
        assert inner.requests[-1]["op"] == "replace"
        assert client._revision == "rev-9"
        assert client._document_count == 0
        assert client._process_generation == 2   # 镜像来自宿主导出
        assert await client.reuse_if_current("rev-9") is True
        assert inner.reuse_calls == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_host_maps_worker_error_to_envelope_error(running_host):
    host, _inner = running_host
    client = SocketSidecarClient("owner-host", socket_path=host.socket_path)
    try:
        with pytest.raises(TsSidecarUnavailable) as exc_info:
            await client._request({"op": "boom"})
        assert exc_info.value.code == "revision_mismatch"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_host_transient_short_circuit_avoids_forward(running_host):
    from types import SimpleNamespace

    host, inner = running_host
    inner._process = SimpleNamespace(returncode=None)
    inner._transient_revision = "mem-7"
    inner._transient_generation = inner._process_generation
    client = SocketSidecarClient("owner-host", socket_path=host.socket_path)
    try:
        await client.replace_transient([], "mem-7", force=False)
        # 短路生效：没有真正转发给内层 client
        assert all(p.get("op") != "replace_transient" for p in inner.requests)
        # 宿主短路响应回填了瞬态指纹镜像
        assert client._transient_revision == "mem-7"
    finally:
        await client.close()


# ── 宿主 idle reaper：关闭期间被重新激活的 client 不得被回收 ─────────────


class _ReapProbeClient:
    """is_idle/touch/close 行为可控的最小 client 替身。"""

    def __init__(self, name: str):
        self.name = name
        self.idle_flag = True
        self.closed = False

    def touch(self) -> None:
        self.idle_flag = False

    def is_idle(self, now=None) -> bool:
        return self.idle_flag

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_host_reaper_rechecks_idle_after_each_close(monkeypatch):
    """回归：reaper 一次性收集 idle 列表后，关闭 A 的 await 期间 B 来了新请求
    （touch → is_idle 变 False），轮到 B 时必须重验并跳过，绝不能把刚开始
    服务的 worker 关掉（旧实现无条件 pop+close，偶发 sidecar unavailable）。"""
    from agent.rag.sidecar_host import SidecarHost

    host = SidecarHost("/tmp/sss-reap-race.sock")
    a, b = _ReapProbeClient("a"), _ReapProbeClient("b")
    host._clients["owner-a"] = a
    host._clients["owner-b"] = b

    async def a_close():
        # close(A) 的 await 期间：B 被新请求激活。
        b.touch()
        await asyncio.sleep(0.01)
        a.closed = True

    a.close = a_close

    reaped = await host._reap_once()

    assert a.closed and reaped == 1
    # B 已被新请求使用：不得回收，且仍是 dict 里那个实例。
    assert not b.closed
    assert host._clients.get("owner-b") is b
    # B 活跃后，下一轮清扫不再动它。
    assert await host._reap_once() == 0


@pytest.mark.asyncio
async def test_host_reaper_reaps_still_idle_clients_in_order():
    """正常路径：两个都保持空闲时按列表回收；owner 槽位被清空。"""
    from agent.rag.sidecar_host import SidecarHost

    host = SidecarHost("/tmp/sss-reap-idle.sock")
    a, b = _ReapProbeClient("a"), _ReapProbeClient("b")
    host._clients["owner-a"] = a
    host._clients["owner-b"] = b

    reaped = await host._reap_once()

    assert reaped == 2
    assert a.closed and b.closed
    assert not host._clients
