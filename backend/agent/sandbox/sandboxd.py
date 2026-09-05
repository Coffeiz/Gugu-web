"""sandboxd：通过 Unix Socket 承接生产 Docker 沙盒执行。

该进程只接受允许目录下的 root，不接受镜像、挂载、网络、UID 或 Docker 参数。
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import os
import socket
import struct
import logging
import uuid
import json
from pathlib import Path

from app.core.config import get_settings

from .docker import DockerSandboxExecutor
from .docker_runtime import cleanup_orphan_pty_containers, docker_network_available, valid_egress_network_name
from .protocol import ExecuteRequest, encode_response

logger = logging.getLogger("agent.sandbox.sandboxd")


class SandboxdServer:
    def __init__(self, socket_path: str | Path, allowed_root: str | Path):
        self.socket_path = Path(socket_path).expanduser()
        self.allowed_root = Path(allowed_root).expanduser().resolve(strict=True)
        self._slots = asyncio.Semaphore(4)
        self._active: dict[str, str] = {}
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._active_lock = asyncio.Lock()

    def _validate_root(self, root: str) -> Path:
        path = Path(root).expanduser().resolve(strict=True)
        if path != self.allowed_root and self.allowed_root not in path.parents:
            raise ValueError("sandboxd root 不在允许的用户数据目录内")
        if not path.is_dir():
            raise ValueError("sandboxd root 必须是目录")
        return path

    @staticmethod
    def _validate_peer(writer: asyncio.StreamWriter) -> None:
        """只接受同一运行用户发来的 Unix socket 请求。"""
        sock = writer.get_extra_info("socket")
        if sock is None or not hasattr(socket, "SO_PEERCRED"):
            raise ValueError("sandboxd 无法确认请求来源")
        credentials = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, _gid = struct.unpack("3i", credentials)
        if uid != os.getuid():
            raise ValueError("sandboxd 请求身份无效")
        if pid <= 0:
            raise ValueError("sandboxd 请求进程无效")

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        result = None
        value = None
        try:
            self._validate_peer(writer)
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            if not line or len(line) > 1_048_576:
                raise ValueError("sandboxd 请求无效")
            value = json.loads(line.decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("sandboxd operation 无效")
            if value.get("operation") == "pty_open":
                await self._handle_pty(value, reader, writer)
                return
            if value.get("operation") == "cancel":
                request_id = str(value.get("request_id") or "").strip()
                task = self._active_tasks.get(request_id)
                writer.write(encode_response({"ok": bool(task), "cancelled": bool(task)}))
                await writer.drain()
                if task is not None:
                    task.cancel()
                return
            if value.get("operation") != "execute":
                raise ValueError("sandboxd operation 无效")
            request = ExecuteRequest.from_dict(value)
            root = self._validate_root(request.root)
            personal_root = self._validate_root(request.personal_root) if request.personal_root else None
            project_root = self._validate_root(request.project_root) if request.project_root else None
            quota_root = self._validate_root(request.quota_root) if request.quota_root else None
            request_id = uuid.uuid4().hex
            request_key = request.request_id or request_id
            self._active_tasks[request_key] = asyncio.current_task()
            async with self._slots:
                async with self._active_lock:
                    self._active[request_key] = str(root)
                try:
                    executor = DockerSandboxExecutor(
                        root, get_settings().sandbox,
                        personal_root=personal_root, project_root=project_root,
                        personal_read_only=request.personal_read_only,
                        project_read_only=request.project_read_only,
                    )
                    if request.network_profile == "egress":
                        sandbox_settings = get_settings().sandbox
                        from .docker_runtime import valid_egress_proxy
                        if not valid_egress_proxy(sandbox_settings.egress_proxy_url):
                            raise ValueError("egress 需要配置受控 HTTP(S) 代理")
                        if not sandbox_settings.egress_isolation_enabled:
                            raise ValueError("受控 egress 网络尚未启用")
                        egress_network_name = getattr(sandbox_settings, "egress_network_name", "")
                        if not valid_egress_network_name(egress_network_name):
                            raise ValueError("egress 网络名无效")
                        if not docker_network_available(egress_network_name):
                            raise ValueError("受控 egress Docker 网络不存在")
                    output_lock = asyncio.Lock()

                    async def emit_output(stream: str, data: str) -> None:
                        async with output_lock:
                            writer.write(encode_response({"type": "output", "stream": stream, "data": data}))
                            await writer.drain()

                    result = await executor.execute(
                        request.command,
                        cwd=request.cwd,
                        timeout=request.timeout,
                        max_output_chars=request.max_output_chars,
                        quota_root=quota_root,
                        quota_bytes=request.quota_bytes,
                        network_profile=request.network_profile,
                        on_output=emit_output,
                    )
                finally:
                    async with self._active_lock:
                        self._active.pop(request_key, None)
                        self._active_tasks.pop(request_key, None)
            logger.info("sandbox_execute request=%s root=%s active=%d ok=%s quota=%s", request_id, root.name, len(self._active), result.ok, result.quota_exceeded)
            response = {
                "type": "complete",
                "ok": result.ok,
                "exit_code": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "timed_out": result.timed_out,
                "truncated": result.truncated,
                "cwd": result.cwd,
                "permission_revoked": result.permission_revoked,
                "quota_exceeded": result.quota_exceeded,
            }
        except Exception as exc:
            logger.warning("sandbox request rejected operation=%s error=%s", value.get("operation") if isinstance(value, dict) else None, type(exc).__name__)
            response = {"error": str(exc) or type(exc).__name__}
        writer.write(encode_response(response))
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async def _handle_pty(self, value: dict, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        root = self._validate_root(str(value.get("root") or ""))
        personal_root = self._validate_root(str(value.get("personal_root") or "")) if value.get("personal_root") else None
        project_root = self._validate_root(str(value.get("project_root") or "")) if value.get("project_root") else None
        personal_read_only = bool(value.get("personal_read_only", True))
        project_read_only = bool(value.get("project_read_only", True))
        if value.get("shell_mode") != "sandbox":
            raise ValueError("sandboxd PTY 只支持 sandbox 范围")
        cols, rows = int(value.get("cols", 120)), int(value.get("rows", 32))
        if not 20 <= cols <= 500 or not 5 <= rows <= 200:
            raise ValueError("sandboxd PTY 尺寸无效")
        settings = get_settings().sandbox
        executor = DockerSandboxExecutor(
            root, settings, personal_root=personal_root, project_root=project_root,
            personal_read_only=personal_read_only, project_read_only=project_read_only,
        )
        container_name = f"gugu-pty-{uuid.uuid4().hex}"
        handle = await executor.open_pty(
            cwd=".", network_profile=str(value.get("network_profile") or "none"),
            container_name=container_name,
            code_execution_enabled=bool(settings.code_execution_enabled),
        )
        await handle.resize(cols, rows)
        writer.write((json.dumps({"type": "ready", "pid": handle.pid, "sandbox_id": handle.sandbox_id}) + "\n").encode())
        await writer.drain()

        output_total_bytes = 0
        output_window_bytes = 0
        output_started = asyncio.get_running_loop().time()

        async def pump() -> None:
            nonlocal output_total_bytes, output_window_bytes, output_started
            async for chunk in handle.output():
                output_total_bytes += len(chunk)
                output_window_bytes += len(chunk)
                now = asyncio.get_running_loop().time()
                if now - output_started >= 1:
                    output_started = now
                    output_window_bytes = len(chunk)
                if (
                    output_total_bytes > settings.pty_output_limit_bytes
                    or output_window_bytes > settings.pty_output_rate_bytes
                ):
                    await handle.close(force=True)
                    break
                writer.write((json.dumps({"type": "output", "data": base64.b64encode(chunk).decode("ascii")}) + "\n").encode())
                await writer.drain()
            writer.write(b'{"type":"exit"}\n')
            await writer.drain()

        pump_task = asyncio.create_task(pump())
        try:
            while True:
                control = await reader.readline()
                if not control:
                    break
                message = json.loads(control.decode("utf-8"))
                message_type = message.get("type")
                if message_type == "input":
                    await handle.write(base64.b64decode(message.get("data", ""), validate=True))
                elif message_type == "resize":
                    await handle.resize(int(message["cols"]), int(message["rows"]))
                elif message_type == "signal":
                    await handle.signal(str(message["signal"]))
                elif message_type == "close":
                    await handle.close(force=bool(message.get("force")))
                    break
                else:
                    raise ValueError("sandboxd PTY 控制消息无效")
        finally:
            if not pump_task.done():
                pump_task.cancel()
                await asyncio.gather(pump_task, return_exceptions=True)
            await handle.close(force=True)

    async def serve(self) -> None:
        cleaned = await asyncio.to_thread(cleanup_orphan_pty_containers)
        if cleaned:
            logger.info("sandboxd 已清理 %d 个遗留 PTY 容器", cleaned)
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        server = await asyncio.start_unix_server(self.handle, path=str(self.socket_path))
        os.chmod(self.socket_path, 0o660)
        async with server:
            await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Gugu Rootless Docker sandboxd")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--allowed-root", required=True)
    args = parser.parse_args()
    asyncio.run(SandboxdServer(args.socket, args.allowed_root).serve())


if __name__ == "__main__":
    main()
