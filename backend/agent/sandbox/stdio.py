"""通过 sandboxd 在 Rootless Docker 内承载 MCP stdio 会话。

Web/Agent 进程只连接 sandboxd Unix socket；不会在宿主机启动用户提供的命令。
协议仍是 JSON Lines，但控制通道的 payload 使用 base64，避免用户 server 的
换行内容破坏 sandboxd 控制帧。
"""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path


class SandboxdStdioUnavailable(RuntimeError):
    """stdio 沙盒不可用；调用方不得回退到宿主机执行。"""


class SandboxdStdioHandle:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, pid: int, sandbox_id: str):
        self.reader, self.writer = reader, writer
        self.pid, self.sandbox_id = pid, sandbox_id
        self._write_lock = asyncio.Lock()
        self._closed = False

    async def _send(self, value: dict) -> None:
        async with self._write_lock:
            self.writer.write((json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8"))
            await self.writer.drain()

    async def write(self, data: bytes) -> None:
        if not data or self._closed:
            return
        await self._send({"type": "input", "data": base64.b64encode(data).decode("ascii")})

    async def read(self) -> bytes | None:
        if self._closed:
            return None
        try:
            line = await self.reader.readline()
        except (ConnectionError, OSError) as exc:
            raise SandboxdStdioUnavailable("sandboxd stdio 连接中断") from exc
        if not line:
            return None
        try:
            value = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SandboxdStdioUnavailable("sandboxd stdio 返回格式无效") from exc
        if value.get("type") == "output":
            try:
                return base64.b64decode(value.get("data", ""), validate=True)
            except (ValueError, TypeError) as exc:
                raise SandboxdStdioUnavailable("sandboxd stdio 输出无效") from exc
        if value.get("type") == "exit":
            raise SandboxdStdioUnavailable("MCP stdio server 已退出")
        raise SandboxdStdioUnavailable("sandboxd stdio 返回未知消息")

    async def close(self, *, force: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._send({"type": "close", "force": force})
        except (ConnectionError, OSError):
            pass
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except OSError:
            pass


class SandboxdStdioClient:
    def __init__(self, socket_path: str | Path, *, connect_timeout: float = 2.0):
        self.socket_path = str(socket_path)
        self.connect_timeout = connect_timeout

    async def open(self, *, root: str, command: str, cwd: str = ".", timeout: float = 30.0) -> SandboxdStdioHandle:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path), timeout=self.connect_timeout,
            )
            writer.write((json.dumps({
                "operation": "stdio_open", "root": root, "command": command,
                "cwd": cwd, "timeout": timeout, "network_profile": "none",
            }, ensure_ascii=False) + "\n").encode("utf-8"))
            await writer.drain()
            ready = json.loads((await asyncio.wait_for(reader.readline(), timeout=5)).decode("utf-8"))
            if ready.get("type") != "ready":
                raise SandboxdStdioUnavailable(ready.get("error", "sandboxd stdio 启动失败"))
            return SandboxdStdioHandle(reader, writer, int(ready["pid"]), str(ready["sandbox_id"]))
        except (OSError, asyncio.TimeoutError, ValueError, json.JSONDecodeError) as exc:
            raise SandboxdStdioUnavailable("sandboxd stdio 不可用，未启动宿主进程") from exc
