"""gugu-rag-sidecar 宿主：统一托管 per-owner TS worker，经 unix socket 共享。

多个 Python 进程（uvicorn worker、gugu-worker、gateway）连接本宿主后共享同一份
热索引，后端重启不再触发 RAG 冷装载。宿主内持有真实的 ``TsSidecarClient``
（spawn/ping/磁盘恢复/空闲回收逻辑全部复用），把信封请求按 owner 路由转发。

协议（行分界 JSON，读上限与 stdio 相同 32MB）：
    请求 {"v":1, "req_id", "owner", "timeout_ms", "payload"}
    响应 {"req_id", "payload", "state"}            state=宿主内 client 状态镜像
    错误 {"req_id", "status":"error", "code", "message"}

两个特殊 op 在宿主侧判定（判定依据是宿主内真实 worker 进程状态，跨进程不可见）：
    reuse_if_current → 磁盘恢复/revision 比对后回 {"ok": bool}
    replace_transient → 指纹未变且进程未重启时短路，不重传 Memory 语料

启动：``python -m agent.rag.sidecar_host --socket /run/user/<uid>/gugu-rag-sidecar.sock``
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
from pathlib import Path
from typing import Any

from agent.rag.ts_sidecar import (
    SIDECAR_STREAM_LIMIT_BYTES,
    SIDE_CAR_IDLE_TTL_SECONDS,
    TsSidecarClient,
    TsSidecarUnavailable,
    _client_state_mirror,
    index_dir_for_owner,
)

_log = logging.getLogger("agent.rag.sidecar_host")

RANK_OWNER = "__rank__"
REAP_INTERVAL_SECONDS = 60


class SidecarHost:
    def __init__(self, socket_path: str):
        self.socket_path = socket_path
        self._clients: dict[str, TsSidecarClient] = {}
        self._lock = asyncio.Lock()
        self._server: asyncio.Server | None = None
        self._reaper: asyncio.Task | None = None

    def _client_for(self, owner: str) -> TsSidecarClient:
        """按 owner 取宿主内真实 client；直接构造，不走 get_lexical_client
        （后者在 socket 配置存在时会递归连回宿主自己）。"""
        client = self._clients.get(owner)
        if client is None:
            from app.core.config import get_settings

            command = get_settings().search.ts_sidecar_command
            index_dir = "" if owner == RANK_OWNER else index_dir_for_owner(owner)
            client = TsSidecarClient(owner, command=command, index_dir=index_dir)
            self._clients[owner] = client
        client.touch()
        return client

    async def handle_request(self, envelope: dict) -> tuple[dict, TsSidecarClient | None]:
        """处理单个信封；返回 (响应 payload, 本次使用的内层 client)。"""
        owner = str(envelope.get("owner") or "")
        payload = envelope.get("payload")
        if not owner or not isinstance(payload, dict):
            return ({"status": "error", "code": "bad_request",
                     "message": "信封缺少 owner/payload"}, None)
        timeout_ms = int(envelope.get("timeout_ms") or 0)
        timeout_seconds = max(0.05, timeout_ms / 1000) if timeout_ms else None
        client = self._client_for(owner)
        op = payload.get("op")
        try:
            if op == "reuse_if_current":
                ok = await client.reuse_if_current(payload.get("revision"))
                return {"ok": ok}, client
            if op == "replace_transient":
                short = self._transient_short_circuit(client, payload)
                if short is not None:
                    return short, client
            response = await client._request(payload, timeout_seconds=timeout_seconds)
            return dict(response.response), client
        except TsSidecarUnavailable as exc:
            return ({"status": "error", "code": exc.code or "sidecar_unavailable",
                     "message": str(exc)}, client)

    @staticmethod
    def _transient_short_circuit(client: TsSidecarClient, payload: dict) -> dict | None:
        """指纹未变且宿主内 worker 进程未重启 → 瞬态语料已在，免重传。"""
        if payload.get("force"):
            return None
        process = client._process
        if process is None or process.returncode is not None:
            return None
        revision = str(payload.get("revision") or "")
        if (client._transient_revision == revision
                and client._transient_generation == client._process_generation):
            return {"status": "ok", "revision": revision, "short_circuit": True}
        return None

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    envelope = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload, client = await self.handle_request(envelope)
                response: dict[str, Any] = {
                    "req_id": envelope.get("req_id"),
                    "payload": payload,
                    "state": _client_state_mirror(client) if client is not None else {},
                }
                if payload.get("status") == "error":
                    response = {
                        "req_id": envelope.get("req_id"),
                        "status": "error",
                        "code": payload.get("code"),
                        "message": payload.get("message"),
                    }
                writer.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
                await writer.drain()
        except (ConnectionError, OSError, ValueError):
            # ValueError = readline 流上限：半行残留后该连接不可信，丢弃整条连接。
            pass
        finally:
            try:
                writer.close()
            except (ConnectionError, OSError):
                pass

    async def _reap_idle(self) -> None:
        while True:
            await asyncio.sleep(REAP_INTERVAL_SECONDS)
            await self._reap_once()

    async def _reap_once(self) -> int:
        """清扫一轮空闲 worker，返回回收数。"""
        idle = [owner for owner, client in self._clients.items()
                if client.is_idle()]
        reaped = 0
        for owner in idle:
            # 关闭上一个 client 的 await 期间，这个 owner 可能刚来新请求
            # （_client_for 的 touch 会刷新最后使用时间、请求随后 active++）。
            # 真正回收前必须在锁内重验「dict 里仍是这个 owner 的 client 且仍
            # 空闲」；锁不跨 close 的 await——close 期间的新请求会拿到新 client，
            # 与被回收的旧实例互不影响。
            async with self._lock:
                client = self._clients.get(owner)
                if client is None or not client.is_idle():
                    continue
                self._clients.pop(owner, None)
            await client.close()
            reaped += 1
            _log.info("sidecar 宿主回收空闲 worker owner=%s…", owner[:8])
        return reaped

    async def start(self) -> None:
        path = Path(self.socket_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.unlink()   # 残留 socket 文件
        self._server = await asyncio.start_unix_server(
            self._handle_connection, path=str(path), limit=SIDECAR_STREAM_LIMIT_BYTES,
        )
        path.chmod(0o600)
        self._reaper = asyncio.create_task(self._reap_idle())
        _log.info("sidecar 宿主就绪 socket=%s", self.socket_path)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        if self._reaper is not None:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)
        for owner, client in self._clients.items():
            await client.close()
        _log.info("sidecar 宿主已关闭（workers=%d）", len(self._clients))


async def _amain(socket_path: str) -> None:
    from app.core.config import get_settings

    get_settings()   # 提前加载配置，worker 子进程的环境注入依赖它
    host = SidecarHost(socket_path)
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)
    await host.start()
    await stop_event.wait()
    await host.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="gugu-rag-sidecar 宿主")
    parser.add_argument("--socket", required=True, help="unix socket 路径")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stdout,
    )
    asyncio.run(_amain(args.socket))


if __name__ == "__main__":
    main()
