"""受限 Unix Socket IPC：仅供 split backend 调用 updater 服务。"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
from pathlib import Path
from typing import Any, Awaitable, Callable


MAX_REQUEST_BYTES = 1_000_000
ALLOWED_METHODS = {"health", "status", "check", "preflight", "start", "rollback_preflight", "rollback"}


class UpdaterRpcError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


async def call_rpc(method: str, params: dict[str, Any], *, socket_path: str | None = None) -> dict[str, Any]:
    if method not in ALLOWED_METHODS:
        raise UpdaterRpcError("invalid_request", "不支持的更新动作")
    path = socket_path or os.getenv("GUGU_UPDATER_RPC_SOCKET", "/run/gugu-updater/updater.sock")
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), timeout=5)
        writer.write(json.dumps({"method": method, "params": params}, separators=(",", ":")).encode() + b"\n")
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=95)
        writer.close()
        await writer.wait_closed()
    except (OSError, asyncio.TimeoutError) as exc:
        raise UpdaterRpcError("updater_unavailable", "分体更新服务暂不可用") from exc
    if not line or len(line) > MAX_REQUEST_BYTES:
        raise UpdaterRpcError("updater_unavailable", "分体更新服务返回无效响应")
    try:
        response = json.loads(line)
    except json.JSONDecodeError as exc:
        raise UpdaterRpcError("updater_unavailable", "分体更新服务返回无效响应") from exc
    if not isinstance(response, dict):
        raise UpdaterRpcError("updater_unavailable", "分体更新服务返回无效响应")
    if response.get("error"):
        error = response["error"]
        if isinstance(error, dict):
            raise UpdaterRpcError(str(error.get("code") or "operation_failed"), str(error.get("message") or "更新服务失败"))
        raise UpdaterRpcError("operation_failed", "更新服务失败")
    result = response.get("result")
    if not isinstance(result, dict):
        raise UpdaterRpcError("updater_unavailable", "分体更新服务返回无效响应")
    return result


async def serve_unix(
    socket_path: str,
    dispatch: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
) -> asyncio.AbstractServer:
    path = Path(socket_path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o770)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode):
            raise RuntimeError("updater IPC 路径已被非 socket 文件占用")
        path.unlink()
    server = await asyncio.start_unix_server(
        lambda reader, writer: _handle(reader, writer, dispatch), path=str(path), limit=MAX_REQUEST_BYTES + 1,
    )
    os.chmod(path, 0o660)
    return server


async def _handle(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    dispatch: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
) -> None:
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not line or len(line) > MAX_REQUEST_BYTES:
            raise UpdaterRpcError("invalid_request", "更新请求格式无效")
        request = json.loads(line)
        if not isinstance(request, dict) or request.get("method") not in ALLOWED_METHODS or not isinstance(request.get("params"), dict):
            raise UpdaterRpcError("invalid_request", "更新请求格式无效")
        result = await asyncio.wait_for(dispatch(request), timeout=90)
        response = {"result": result}
    except UpdaterRpcError as exc:
        response = {"error": {"code": exc.code, "message": str(exc)}}
    except asyncio.TimeoutError:
        response = {"error": {"code": "operation_failed", "message": "更新服务请求超时"}}
    except (json.JSONDecodeError, UnicodeDecodeError):
        response = {"error": {"code": "invalid_request", "message": "更新请求格式无效"}}
    except Exception:
        response = {"error": {"code": "internal_error", "message": "更新服务内部错误"}}
    try:
        writer.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()
