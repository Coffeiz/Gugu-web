"""Gugu Web 到 sandboxd 的 Unix Socket 客户端。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .protocol import ExecuteRequest


class SandboxdUnavailable(RuntimeError):
    """sandboxd 不可用；调用方不得回退到本机执行。"""


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
