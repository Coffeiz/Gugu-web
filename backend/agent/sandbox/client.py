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
                "personal_root": spec.personal_root,
                "project_root": spec.project_root,
                "workspace_mounts": [
                    {"target": mount.target, "root": mount.root} for mount in spec.workspace_mounts
                ],
                "primary_workspace": spec.primary_workspace,
                "personal_read_only": spec.personal_read_only,
                "project_read_only": spec.project_read_only,
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
    _cancel_timeout = 1.0

    def __init__(self, socket_path: str | Path, *, connect_timeout: float = 2.0):
        self.socket_path = str(socket_path)
        self.connect_timeout = connect_timeout

    async def prepare_filesync_access(self, workspace_root: str | Path) -> None:
        """请求 sandboxd 在单个已授权 workspace 内修复 watcher ACL。"""
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path), timeout=self.connect_timeout,
            )
            writer.write((json.dumps({
                "operation": "filesync_prepare", "root": str(workspace_root),
            }) + "\n").encode("utf-8"))
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout=125)
            value = json.loads(line.decode("utf-8"))
            if not isinstance(value, dict) or not value.get("ok"):
                raise SandboxdUnavailable("文件同步工作区权限初始化失败")
        except (OSError, asyncio.TimeoutError, ValueError, json.JSONDecodeError) as exc:
            raise SandboxdUnavailable("sandboxd 文件同步权限助手不可用") from exc
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def execute(self, request: ExecuteRequest) -> dict[str, Any]:
        return await self.execute_stream(request)

    async def cancel(self, request_id: str) -> bool:
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path), timeout=self.connect_timeout,
            )
            writer.write((json.dumps({"operation": "cancel", "request_id": request_id}) + "\n").encode())
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout=self.connect_timeout)
            value = json.loads(line.decode("utf-8"))
            return bool(value.get("cancelled"))
        except (OSError, asyncio.TimeoutError, ValueError, json.JSONDecodeError):
            return False
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def execute_stream(self, request: ExecuteRequest, on_output=None) -> dict[str, Any]:
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
            deadline = asyncio.get_running_loop().time() + max(request.timeout, 2.0) + 2.0
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=max(0.1, deadline - asyncio.get_running_loop().time()))
                if not line:
                    raise SandboxdUnavailable("sandboxd 未返回执行结果")
                try:
                    value = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise SandboxdUnavailable("sandboxd 返回格式无效") from exc
                if not isinstance(value, dict):
                    raise SandboxdUnavailable("sandboxd 返回结果无效")
                if value.get("type") == "output":
                    if on_output is not None:
                        await on_output(str(value.get("stream") or "stdout"), str(value.get("data") or ""))
                    continue
                return value
        except asyncio.CancelledError:
            # 关闭执行连接只会断开输出流；sandboxd 中的任务仍可能继续运行。
            # 用独立控制连接通知它取消，并严格限制清理等待时间。
            if request.request_id:
                cancel_task = asyncio.create_task(self.cancel(request.request_id))
                try:
                    await asyncio.wait_for(asyncio.shield(cancel_task), timeout=self._cancel_timeout)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    cancel_task.cancel()
                    await asyncio.gather(cancel_task, return_exceptions=True)
            raise
        except (OSError, asyncio.TimeoutError) as exc:
            raise SandboxdUnavailable("sandboxd 连接中断，未执行命令") from exc
        finally:
            writer.close()
            await writer.wait_closed()
