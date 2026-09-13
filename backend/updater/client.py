"""通过私有 Unix Socket 调用受限 updater sidecar。"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any


class UpdaterClientError(RuntimeError):
    def __init__(self, code: str, message: str = "更新服务暂不可用") -> None:
        super().__init__(message)
        self.code = code


async def call_updater(method: str, **params: Any) -> dict[str, Any]:
    """发送一条有长度上限的 JSONL RPC；不接受调用者指定 socket 或命令。"""
    socket_path = os.getenv("GUGU_UPDATER_SOCKET", "/run/gugu-updater/control.sock")
    timeout = 90 if method in {"check", "preflight", "start", "rollback_preflight", "rollback"} else 12
    writer: asyncio.StreamWriter | None = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(socket_path, limit=65536), timeout=3
        )
        payload = json.dumps({"method": method, "params": params}, separators=(",", ":"))
        if len(payload.encode("utf-8")) > 32768:
            raise UpdaterClientError("request_too_large", "更新请求过大")
        writer.write(payload.encode("utf-8") + b"\n")
        await writer.drain()
        raw = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if not raw or len(raw) > 65536:
            raise UpdaterClientError("invalid_response")
        response = json.loads(raw)
        if not isinstance(response, dict):
            raise UpdaterClientError("invalid_response")
        if response.get("ok") is not True:
            code = str(response.get("code") or "updater_error")[:64]
            message = str(response.get("message") or "更新服务拒绝了请求")[:240]
            raise UpdaterClientError(code, message)
        result = response.get("result")
        if not isinstance(result, dict):
            raise UpdaterClientError("invalid_response")
        return result
    except UpdaterClientError:
        raise
    except (OSError, asyncio.TimeoutError, json.JSONDecodeError, ValueError) as exc:
        raise UpdaterClientError("updater_unavailable") from exc
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
