"""MCP stdio 客户端：仅通过 sandboxd Unix socket 与容器内进程通信。"""
from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any

from app.core.config import get_settings
from agent.mcp.models import (
    CLIENT_INFO,
    MCP_LEGACY_PROTOCOL_VERSION,
    MCP_MODERN_PROTOCOL_VERSION,
    MCP_TASKS_EXTENSION,
)
from agent.mcp.protocol import advertises_tasks, is_legacy_probe_error, with_protocol_metadata
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
        self._protocol_version: str | None = None
        self._modern = False
        self._supports_tasks = False

    async def aclose(self) -> None:
        if self._handle is not None:
            await self._handle.close(force=True)
            self._handle = None
        self._initialized = False

    async def initialize(self) -> dict:
        try:
            result = await self._request(
                "server/discover", {}, protocol_version=MCP_MODERN_PROTOCOL_VERSION,
            )
        except _StdioClientError as exc:
            if not is_legacy_probe_error(transport="stdio", kind=exc.kind, code=exc.code):
                return {"error": exc.message, "error_kind": exc.kind}
            try:
                result = await self._request("initialize", {
                    "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
                    "capabilities": {}, "clientInfo": CLIENT_INFO,
                })
            except _StdioClientError as legacy_exc:
                return {"error": legacy_exc.message, "error_kind": legacy_exc.kind}
            await self._notify("notifications/initialized")
            self._modern = False
            self._supports_tasks = False
            self._initialized = True
            return result or {}

        supported = result.get("supportedVersions")
        if not isinstance(supported, list) or MCP_MODERN_PROTOCOL_VERSION not in supported:
            return {"error": "MCP stdio server 未声明客户端支持的现代协议版本", "error_kind": "protocol"}
        self._protocol_version = MCP_MODERN_PROTOCOL_VERSION
        self._modern = True
        self._supports_tasks = advertises_tasks(result)
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
            params = {
                "name": name,
                "arguments": dict(arguments or {}),
            }
            if self._supports_tasks:
                params["_meta"] = {"io.modelcontextprotocol/clientCapabilities": {
                    "extensions": {MCP_TASKS_EXTENSION: {}}
                }}
            result = await self._request("tools/call", params)
            if result.get("resultType") == "task" and result.get("taskId"):
                if not self._supports_tasks:
                    return {"error": "MCP stdio server 返回了未协商的 Tasks 结果", "error_kind": "protocol"}
                from agent.mcp.tasks import wait_for_task

                task_id = str(result["taskId"])
                return await wait_for_task(
                    task_id, result,
                    request=self._request,
                    cancel=lambda: self._request("tasks/cancel", {"taskId": task_id}),
                )
            return result
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

    async def _request(
        self, method: str, params: dict[str, Any], *, protocol_version: str | None = None,
    ) -> dict:
        if protocol_version is None and self._modern:
            protocol_version = self._protocol_version
        if protocol_version:
            params = with_protocol_metadata(params, protocol_version)
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
                        raise _StdioClientError(
                            f"MCP server 协议错误：{message or '未知错误'}", "protocol",
                            rpc_error=error if isinstance(error, dict) else None,
                        )
                    return payload.get("result") or {}
            except asyncio.CancelledError:
                # stdio 的请求仍在同一持久连接上；按 MCP 标准通知请求已取消，
                # 然后传播 task cancel。该通知是协作式信号，不能证明进程已停止。
                if method in {"tools/call", "tasks/get"}:
                    from agent.runtime.cancellation import mark_remote_cancel_uncertain
                    mark_remote_cancel_uncertain()
                if not method.startswith("tasks/"):
                    try:
                        await asyncio.shield(self._write_message({
                            "jsonrpc": "2.0",
                            "method": "notifications/cancelled",
                            "params": {"requestId": request_id, "reason": "用户取消当前运行"},
                        }))
                    except Exception:
                        pass
                raise
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
    def __init__(self, message: str, kind: str, *, rpc_error: dict | None = None):
        self.message, self.kind = message, kind
        self.code = rpc_error.get("code") if isinstance(rpc_error, dict) else None
        super().__init__(message)
