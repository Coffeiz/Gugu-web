"""sandboxd：通过 Unix Socket 承接生产 Docker 沙盒执行。

该进程只接受允许目录下的 root，不接受镜像、挂载、网络、UID 或 Docker 参数。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import socket
import struct
import logging
import uuid
from pathlib import Path

from app.core.config import get_settings

from .docker import DockerSandboxExecutor
from .docker_runtime import docker_network_available, valid_egress_network_name
from .protocol import ExecuteRequest, encode_response

logger = logging.getLogger("agent.sandbox.sandboxd")


class SandboxdServer:
    def __init__(self, socket_path: str | Path, allowed_root: str | Path):
        self.socket_path = Path(socket_path).expanduser()
        self.allowed_root = Path(allowed_root).expanduser().resolve(strict=True)
        self._slots = asyncio.Semaphore(4)
        self._active: dict[str, str] = {}
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
        try:
            self._validate_peer(writer)
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            if not line or len(line) > 1_048_576:
                raise ValueError("sandboxd 请求无效")
            import json
            value = json.loads(line.decode("utf-8"))
            if not isinstance(value, dict) or value.get("operation") != "execute":
                raise ValueError("sandboxd operation 无效")
            request = ExecuteRequest.from_dict(value)
            root = self._validate_root(request.root)
            quota_root = self._validate_root(request.quota_root) if request.quota_root else None
            request_id = uuid.uuid4().hex
            async with self._slots:
                async with self._active_lock:
                    self._active[request_id] = str(root)
                try:
                    executor = DockerSandboxExecutor(root, get_settings().sandbox)
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
                    result = await executor.execute(
                        request.command,
                        cwd=request.cwd,
                        timeout=request.timeout,
                        max_output_chars=request.max_output_chars,
                        quota_root=quota_root,
                        quota_bytes=request.quota_bytes,
                        network_profile=request.network_profile,
                    )
                finally:
                    async with self._active_lock:
                        self._active.pop(request_id, None)
            logger.info("sandbox_execute request=%s root=%s active=%d ok=%s quota=%s", request_id, root.name, len(self._active), result.ok, result.quota_exceeded)
            response = {
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
            logger.warning("sandbox_execute rejected: %s", type(exc).__name__)
            response = {"error": str(exc)}
        writer.write(encode_response(response))
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async def serve(self) -> None:
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
