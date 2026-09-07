"""文件同步 TS watcher sidecar 的最小进程桥接。

TS 进程只负责接收目录事件；Python 仍是同步 supervisor、权限校验和 DB 投影的唯一入口。
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any


FILESYNC_PROTOCOL_VERSION = 1


class FileSyncSidecarUnavailable(RuntimeError):
    """TS watcher 未启动、已退出或协议通信失败。"""


class FileSyncSidecar:
    """单个 worker 进程内唯一的 TS watcher sidecar。"""

    def __init__(self, *, command: list[str] | None = None):
        self.command = command or self._default_command()
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=20_000)
        self._sequence = 0
        self._lock = asyncio.Lock()

    @staticmethod
    def _default_command() -> list[str]:
        artifact = Path(__file__).resolve().parents[3] / "bin" / "gugu-filesync-ts-worker.cjs"
        return ["node", str(artifact)]

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        if self.running:
            return
        if not self.command or not Path(self.command[-1]).exists():
            raise FileSyncSidecarUnavailable("TS 文件监听制品不可用")
        async with self._lock:
            if self.running:
                return
            await self._start_process()
            try:
                await self._request_unlocked("ping")
            except (OSError, asyncio.TimeoutError, FileSyncSidecarUnavailable):
                await self.close()
                raise

    async def _start_process(self) -> None:
        try:
            env = os.environ.copy()
            module_root = Path(__file__).resolve().parents[3] / "ts" / "packages" / "filesync-watcher" / "node_modules"
            if module_root.is_dir():
                current_node_path = env.get("NODE_PATH")
                env["NODE_PATH"] = os.pathsep.join(
                    item for item in (str(module_root), current_node_path) if item
                )
            self._process = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )
            self._reader_task = asyncio.create_task(self._read_loop())
        except OSError as exc:
            raise FileSyncSidecarUnavailable("TS 文件监听进程启动失败") from exc

    async def watch(self, binding_id: int, root: Path) -> None:
        await self._request("watch", binding_id=binding_id, root=str(root))

    async def unwatch(self, binding_id: int) -> None:
        await self._request("unwatch", binding_id=binding_id)

    async def next_event(self, timeout: float = 0.0) -> dict[str, Any] | None:
        try:
            if timeout:
                return await asyncio.wait_for(self._events.get(), timeout=timeout)
            return self._events.get_nowait()
        except (asyncio.TimeoutError, asyncio.QueueEmpty):
            return None

    async def close(self) -> None:
        process = self._process
        self._process = None
        reader = self._reader_task
        self._reader_task = None
        for future in self._pending.values():
            if not future.done():
                future.set_exception(FileSyncSidecarUnavailable("TS 文件监听已关闭"))
        self._pending.clear()
        if reader is not None:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        if process is None:
            return
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def _request(self, op: str, **payload: Any) -> dict[str, Any]:
        async with self._lock:
            if not self.running:
                if not self.command or not Path(self.command[-1]).exists():
                    raise FileSyncSidecarUnavailable("TS 文件监听制品不可用")
                await self._start_process()
                await self._request_unlocked("ping")
            return await self._request_unlocked(op, **payload)

    async def _request_unlocked(self, op: str, **payload: Any) -> dict[str, Any]:
        if self._process is None or self._process.stdin is None:
            raise FileSyncSidecarUnavailable("TS 文件监听未运行")
        self._sequence += 1
        request_id = f"fs-{self._sequence}"
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        request = {
            "protocol": FILESYNC_PROTOCOL_VERSION,
            "id": request_id,
            "op": op,
            **payload,
        }
        try:
            self._process.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode())
            await self._process.stdin.drain()
            response = await asyncio.wait_for(future, timeout=10)
        except (BrokenPipeError, ConnectionError, asyncio.TimeoutError) as exc:
            raise FileSyncSidecarUnavailable("TS 文件监听通信失败") from exc
        finally:
            self._pending.pop(request_id, None)
        if response.get("status") != "ok":
            raise FileSyncSidecarUnavailable("TS 文件监听请求失败")
        return response

    async def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message.get("kind") == "response" and message.get("id") in self._pending:
                    future = self._pending[message["id"]]
                    if not future.done():
                        future.set_result(message)
                    continue
                if message.get("kind") == "event":
                    try:
                        self._events.put_nowait(message)
                    except asyncio.QueueFull:
                        # 丢弃事件前先放入不可丢失的恢复信号；reconcile 会重建完整状态。
                        while not self._events.empty():
                            self._events.get_nowait()
                        self._events.put_nowait({
                            "protocol": FILESYNC_PROTOCOL_VERSION,
                            "kind": "event",
                            "event": "needs_reconcile",
                            "code": "python_event_queue_overflow",
                        })
        finally:
            error = FileSyncSidecarUnavailable("TS 文件监听进程已退出")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
