"""最小 MCP JSON-RPC 客户端（streamable HTTP）。

Phase 1 只承诺 initialize / tools/list / tools/call 三个方法；不实现 SSE 长连接
监听（GET）与 sampling/resources/prompts。安全约束：

- endpoint 属不可信外部地址：每次请求前用 ``resolve_pinned_ip`` 做内网校验并把
  socket 钉扎到校验过的 IP（防 DNS rebinding TOCTOU，每跳重新解析不复用）；
- ``follow_redirects=False``：禁止自动跟随未校验的重定向；
- 超时/连接失败/协议错误一律归一为 ``{"error": 人话, "error_kind": 类别}`` 返回，
  不向上抛异常打断 Agent Loop。

协议要点（streamable HTTP）：POST 单一 endpoint；initialize 后从响应头取
``Mcp-Session-Id`` 并在后续请求回传；响应可能是 application/json 或
text/event-stream（后者按 SSE 帧解析取同 id 的 JSON-RPC 响应）。
"""
from __future__ import annotations

import itertools
import json
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from typing import Any

import httpx

from app.core.url_security import resolve_pinned_ip
from agent.mcp.models import CLIENT_INFO, MCP_PROTOCOL_VERSION

_LIST_TOOLS_MAX_PAGES = 8        # 分页拉全量的防御上限


class McpClientError(Exception):
    """携带人话文案与机器类别的 MCP 客户端错误。"""

    def __init__(self, message: str, kind: str = "protocol"):
        super().__init__(message)
        self.message = message
        self.kind = kind            # timeout | network | http | protocol


def error_payload(exc: McpClientError) -> dict[str, str]:
    return {"error": exc.message, "error_kind": exc.kind}


class McpClient:
    """单 server 的 MCP 客户端；一次实例对应一次 initialize 会话。"""

    def __init__(self, endpoint: str, headers: dict[str, str] | None = None,
                 query_params: dict[str, str] | None = None,
                 timeout_seconds: float = 30.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self._endpoint = endpoint
        self._headers = dict(headers or {})
        self._query_params = {str(k): str(v) for k, v in (query_params or {}).items()}
        self._timeout_seconds = float(timeout_seconds)
        self._timeout = httpx.Timeout(self._timeout_seconds)
        self._transport = transport        # 测试注入 MockTransport；生产走 IP 钉扎
        self._session_id: str | None = None
        self._ids = itertools.count(1)
        self._initialized = False

    async def __aenter__(self) -> "McpClient":
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        return None

    # ── 对外方法：永不抛异常，错误归一为 {"error": 人话, "error_kind": 类别} ──

    async def initialize(self) -> dict:
        try:
            result = await self._request(
                "initialize",
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": CLIENT_INFO,
                },
            )
        except McpClientError as exc:
            return error_payload(exc)
        await self._notify("notifications/initialized")
        self._initialized = True
        return result or {}

    async def list_tools(self) -> dict:
        """返回 {"tools": [...]}；分页拉全量。"""
        tools: list[dict] = []
        cursor: str | None = None
        try:
            if not self._initialized:
                init = await self.initialize()
                if "error" in init:
                    return init
            for _page in range(_LIST_TOOLS_MAX_PAGES):
                params: dict[str, Any] = {"cursor": cursor} if cursor else {}
                result = await self._request("tools/list", params)
                if "error" in result:
                    return result
                tools.extend(result.get("tools") or [])
                cursor = result.get("nextCursor")
                if not cursor:
                    break
            else:
                return {"error": "工具列表分页异常，已到防御上限", "error_kind": "protocol"}
        except McpClientError as exc:
            return error_payload(exc)
        return {"tools": tools}

    async def call_tool(self, name: str, arguments: dict | None) -> dict:
        """调用工具，返回 MCP tools/call 的 result（content/isError）。"""
        try:
            if not self._initialized:
                init = await self.initialize()
                if "error" in init:
                    return init
            return await self._request(
                "tools/call", {"name": name, "arguments": dict(arguments or {})}
            )
        except McpClientError as exc:
            return error_payload(exc)

    # ── 协议内部 ──

    async def _notify(self, method: str) -> None:
        """JSON-RPC 通知（无 id，无响应）。best-effort：失败不阻断初始化流程。"""
        body = {"jsonrpc": "2.0", "method": method}
        try:
            async with self._build_client() as client:
                await client.post(self._request_url(), json=body, headers=self._base_headers())
        except Exception:
            pass

    def _base_headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            **self._headers,
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        return headers

    def _request_url(self) -> str:
        """只在请求边界拼接已解密的 Query 凭据，不修改或回显持久化 endpoint。"""
        if not self._query_params:
            return self._endpoint
        parts = urlsplit(self._endpoint)
        configured_names = set(self._query_params)
        query = [item for item in parse_qsl(parts.query, keep_blank_values=True) if item[0] not in configured_names]
        query.extend(self._query_params.items())
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

    def _build_client(self) -> httpx.AsyncClient:
        transport: httpx.AsyncBaseTransport | None = self._transport
        if transport is None:
            # 每次请求都重新校验并钉扎：resolve_pinned_ip 的约定是每一跳重新解析，
            # 不复用上一跳结果，杜绝校验与连接之间切换 A 记录的 DNS rebinding。
            pinned_ip, resolve_error = resolve_pinned_ip(self._endpoint)
            if not pinned_ip:
                raise McpClientError(
                    resolve_error or "该地址不允许访问（仅放行公网地址）", kind="network"
                )
            from app.core.pinned_http import PinnedHTTPTransport

            transport = PinnedHTTPTransport(pinned_ip)
        return httpx.AsyncClient(
            timeout=self._timeout,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def _request(self, method: str, params: dict | None = None) -> dict:
        """发一个 JSON-RPC 请求并返回 result；协议/网络错误抛 McpClientError。"""
        request_id = next(self._ids)
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            body["params"] = params

        async with self._build_client() as client:
            try:
                resp = await client.post(self._request_url(), json=body, headers=self._base_headers())
            except httpx.TimeoutException as exc:
                raise McpClientError(
                    f"MCP server 响应超时（>{int(self._timeout_seconds)}s），"
                    "请稍后重试或在设置里调大超时",
                    kind="timeout",
                ) from exc
            except httpx.NetworkError as exc:
                raise McpClientError(
                    "无法连接 MCP server，请检查地址与网络", kind="network"
                ) from exc

        # 重定向一律不跟随（未校验的目的地不请求）
        if 300 <= resp.status_code < 400:
            raise McpClientError(
                "MCP server 返回了重定向，出于安全考虑未跟随", kind="http"
            )
        if resp.status_code == 202:
            return {}
        if resp.status_code >= 400:
            raise McpClientError(
                f"MCP server 返回错误状态码 {resp.status_code}", kind="http"
            )

        session_id = resp.headers.get("Mcp-Session-Id")
        if session_id:
            self._session_id = session_id

        payload = self._extract_message(resp, request_id)
        if "error" in payload:
            err = payload.get("error") or {}
            message = err.get("message") if isinstance(err, dict) else str(err)
            raise McpClientError(
                f"MCP server 协议错误：{message or '未知错误'}", kind="protocol"
            )
        return payload.get("result") or {}

    def _extract_message(self, resp: httpx.Response, request_id: int) -> dict:
        """从 application/json 或 text/event-stream 响应里取出本请求的 JSON-RPC 消息。

        POST 默认整包读入（非流式），SSE 流在服务端发送响应后即关闭，两种情况
        都在内存内容上解析。
        """
        content_type = (resp.headers.get("Content-Type") or "").lower()
        if "text/event-stream" not in content_type:
            try:
                payload = resp.json()
            except ValueError as exc:
                raise McpClientError("MCP server 返回了非 JSON 内容", kind="protocol") from exc
            if isinstance(payload, dict) and "jsonrpc" not in payload:
                # 部分网关在 endpoint、Key 或认证方式错误时返回自己的 JSON
                # 错误包；把它和“响应 id 不匹配”区分开，便于定位配置问题。
                provider_info = payload.get("info")
                provider_code = payload.get("infocode")
                if isinstance(provider_info, str) and provider_info.strip():
                    detail = provider_info.strip()
                    if isinstance(provider_code, str) and provider_code.strip():
                        detail = f"{detail}（{provider_code.strip()}）"
                    raise McpClientError(
                        f"MCP server 返回上游错误：{detail}", kind="http"
                    )
            return self._require_matching_id(payload, request_id)

        message: dict | None = None
        data_lines: list[str] = []

        def _flush():
            nonlocal message, data_lines
            if not data_lines:
                return
            try:
                candidate = json.loads("\n".join(data_lines))
            except ValueError:
                candidate = None
            data_lines = []
            if isinstance(candidate, dict) and message is None:
                matched = self._match_id(candidate, request_id)
                if matched is not None:
                    message = matched

        for line in resp.iter_lines():
            line = line.rstrip("\r")
            if line.startswith("data:"):
                data_lines.append(line[len("data:"):].lstrip())
            elif not line.strip():
                _flush()
        _flush()
        if message is None:
            raise McpClientError("MCP server 的 SSE 响应里没有本请求的结果", kind="protocol")
        return message

    @staticmethod
    def _match_id(payload: Any, request_id: int) -> dict | None:
        """SSE 流里可能混有通知/其他请求的响应，只取 id 匹配的本请求消息。

        JSON-RPC 的 id 允许字符串或数字；少数服务端会把客户端的数字 id
        序列化成字符串。两者在这里按 JSON 标量值兼容比较，但不会接受
        缺失 id、null 或其它类型，避免把异步通知误当成本次请求的响应。
        """
        if isinstance(payload, dict) and McpClient._json_rpc_ids_equal(payload.get("id"), request_id):
            return payload
        return None

    @staticmethod
    def _json_rpc_ids_equal(response_id: Any, request_id: int) -> bool:
        if response_id is None or isinstance(response_id, bool):
            return False
        if isinstance(response_id, (int, str)):
            return str(response_id) == str(request_id)
        return False

    @classmethod
    def _require_matching_id(cls, payload: Any, request_id: int) -> dict:
        """JSON 响应必须对应当前请求，否则统一归一为协议错误。"""
        message = cls._match_id(payload, request_id)
        if message is None:
            raise McpClientError(
                "MCP server 返回了不匹配的 JSON-RPC 响应",
                kind="protocol",
            )
        return message
