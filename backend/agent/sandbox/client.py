"""Gugu Web 到 sandboxd 的 Unix Socket 客户端。"""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

from .protocol import ExecuteRequest
from agent.terminal.pty_manager import PtyHandle, PtyLaunchSpec


class SandboxdUnavailable(RuntimeError):
    """sandboxd 不可用；调用方不得回退到本机执行。"""


class SandboxdPtyHandle:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, pid: int, sandbox_id: str):
        self.reader, self.writer = reader, writer
        self.pid, self.sandbox_id = pid, sandbox_id
        self._write_lock = asyncio.Lock()
        self._closed = False

    async def _send(self, value: dict) -> None:
        async with self._write_lock:
            self.writer.write((json.dumps(value, ensure_ascii=False) + "\n").encode())
            await self.writer.drain()

    async def write(self, data: bytes) -> None:
        if not data or self._closed:
            return
        await self._send({"type": "input", "data": base64.b64encode(data).decode("ascii")})

    async def resize(self, cols: int, rows: int) -> None:
        await self._send({"type": "resize", "cols": cols, "rows": rows})

    async def signal(self, signal_name: str) -> None:
        await self._send({"type": "signal", "signal": signal_name})

    async def close(self, *, force: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._send({"type": "close", "force": force})
        finally:
            self.writer.close()
            await self.writer.wait_closed()

    async def output(self):
        while not self._closed:
            line = await self.reader.readline()
            if not line:
                return
            value = json.loads(line.decode("utf-8"))
            if value.get("type") == "output":
                yield base64.b64decode(value.get("data", ""), validate=True)
            elif value.get("type") == "exit":
                return


class SandboxdPtyClient:
    def __init__(self, socket_path: str | Path, *, connect_timeout: float = 2.0):
        self.socket_path = str(socket_path)
        self.connect_timeout = connect_timeout

    async def open(self, spec: PtyLaunchSpec) -> PtyHandle:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path), timeout=self.connect_timeout,
            )
            writer.write((json.dumps({
                "operation": "pty_open", "terminal_id": spec.terminal_id,
                "root": spec.root, "shell_mode": spec.shell_mode,
                "network_profile": spec.network_profile, "cols": spec.cols, "rows": spec.rows,
            }) + "\n").encode())
            await writer.drain()
            ready = json.loads((await asyncio.wait_for(reader.readline(), timeout=5)).decode("utf-8"))
            if ready.get("type") != "ready":
                raise SandboxdUnavailable(ready.get("error", "sandboxd PTY 启动失败"))
            return SandboxdPtyHandle(reader, writer, int(ready["pid"]), str(ready["sandbox_id"]))
        except (OSError, asyncio.TimeoutError, ValueError, json.JSONDecodeError) as exc:
            raise SandboxdUnavailable("sandboxd PTY 不可用，未启动本机 Shell") from exc


class SandboxdClient:
    def __init__(self, socket_path: str | Path, *, connect_timeout: float = 2.0):
        self.socket_path = str(socket_path)
        self.connect_timeout = connect_timeout

    async def execute(self, request: ExecuteRequest) -> dict[str, Any]:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path),
                timeout=self.connect_timeout,
            )
        except (OSError, asyncio.TimeoutError) as exc:
            raise SandboxdUnavailable("sandboxd 不可用，未执行命令") from exc
        try:
            writer.write(request.to_json())
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout=max(request.timeout, 2.0) + 2.0)
            if not line:
                raise SandboxdUnavailable("sandboxd 未返回执行结果")
            try:
                value = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise SandboxdUnavailable("sandboxd 返回格式无效") from exc
            if not isinstance(value, dict):
                raise SandboxdUnavailable("sandboxd 返回结果无效")
            return value
        except (OSError, asyncio.TimeoutError) as exc:
            raise SandboxdUnavailable("sandboxd 连接中断，未执行命令") from exc
        finally:
            writer.close()
            await writer.wait_closed()
