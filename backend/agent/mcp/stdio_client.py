"""MCP stdio 客户端：仅通过 sandboxd Unix socket 与容器内进程通信。"""
from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any

from app.core.config import get_settings
from agent.mcp.models import CLIENT_INFO, MCP_PROTOCOL_VERSION
from agent.sandbox.stdio import SandboxdStdioClient, SandboxdStdioHandle, SandboxdStdioUnavailable

_LIST_TOOLS_MAX_PAGES = 8


class McpStdioClient:
    def __init__(self, command: str, *, root: str, cwd: str = ".", timeout_seconds: float = 30.0):
        self._command = command
        self._root = root
        self._cwd = cwd
        self._timeout_seconds = float(timeout_seconds)
        self._handle: SandboxdStdioHandle | None = None
        self._ids = itertools.count(1)
        self._initialized = False
        self._request_lock = asyncio.Lock()

    async def aclose(self) -> None:
        if self._handle is not None:
            await self._handle.close(force=True)
            self._handle = None
        self._initialized = False

    async def initialize(self) -> dict:
        try:
            result = await self._request("initialize", {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {}, "clientInfo": CLIENT_INFO,
            })
        except _StdioClientError as exc:
            return {"error": exc.message, "error_kind": exc.kind}
        await self._notify("notifications/initialized")
        self._initialized = True
        return result or {}

    async def list_tools(self) -> dict:
        tools: list[dict] = []
        cursor: str | None = None
        try:
            if not self._initialized:
                init = await self.initialize()
                if "error" in init:
                    return init
            for _ in range(_LIST_TOOLS_MAX_PAGES):
                result = await self._request("tools/list", {"cursor": cursor} if cursor else {})
                tools.extend(result.get("tools") or [])
                cursor = result.get("nextCursor")
                if not cursor:
                    return {"tools": tools}
            return {"error": "工具列表分页异常，已到防御上限", "error_kind": "protocol"}
        except _StdioClientError as exc:
            return {"error": exc.message, "error_kind": exc.kind}

    async def call_tool(self, name: str, arguments: dict | None) -> dict:
        try:
            if not self._initialized:
                init = await self.initialize()
                if "error" in init:
                    return init
            return await self._request("tools/call", {"name": name, "arguments": dict(arguments or {})})
        except _StdioClientError as exc:
            return {"error": exc.message, "error_kind": exc.kind}

    async def _notify(self, method: str) -> None:
        try:
            await self._write_message({"jsonrpc": "2.0", "method": method})
        except _StdioClientError:
            pass

    async def _ensure_handle(self) -> SandboxdStdioHandle:
        if self._handle is not None:
            return self._handle
        try:
            self._handle = await SandboxdStdioClient(get_settings().sandbox.sandboxd_socket).open(
                root=self._root, command=self._command, cwd=self._cwd,
                timeout=self._timeout_seconds,
            )
        except SandboxdStdioUnavailable as exc:
            raise _StdioClientError(str(exc), "network") from exc
        return self._handle

    async def _write_message(self, value: dict) -> None:
        handle = await self._ensure_handle()
        await handle.write((json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8"))

    async def _request(self, method: str, params: dict[str, Any]) -> dict:
        async with self._request_lock:
            request_id = next(self._ids)
            try:
                await self._write_message({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
                handle = await self._ensure_handle()
                while True:
                    line = await asyncio.wait_for(handle.read(), timeout=self._timeout_seconds)
                    if line is None:
                        raise _StdioClientError("MCP stdio server 已退出", "network")
                    try:
                        payload = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise _StdioClientError("MCP stdio 返回了非 JSON 内容", "protocol") from exc
                    if not isinstance(payload, dict):
                        raise _StdioClientError("MCP stdio 返回格式无效", "protocol")
                    if payload.get("method") and payload.get("id") is None:
                        continue
                    if payload.get("id") != request_id:
                        continue
                    if "error" in payload:
                        error = payload.get("error") or {}
                        message = error.get("message") if isinstance(error, dict) else str(error)
                        raise _StdioClientError(f"MCP server 协议错误：{message or '未知错误'}", "protocol")
                    return payload.get("result") or {}
            except (asyncio.TimeoutError, TimeoutError) as exc:
                await self.aclose()
                raise _StdioClientError("MCP stdio server 响应超时", "timeout") from exc
            except SandboxdStdioUnavailable as exc:
                await self.aclose()
                raise _StdioClientError(str(exc), "network") from exc
            except (ConnectionError, OSError, BrokenPipeError) as exc:
                await self.aclose()
                raise _StdioClientError("MCP stdio server 连接中断", "network") from exc


class _StdioClientError(Exception):
    def __init__(self, message: str, kind: str):
        self.message, self.kind = message, kind
        super().__init__(message)
