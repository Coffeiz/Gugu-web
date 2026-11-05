"""MCP HTTP 客户端：使用官方 Python SDK 处理协议会话。"""
from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import httpx2
from mcp import Client, types as mcp_types
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp.shared.inbound import encode_header_value

from agent.mcp.protocol import advertises_tasks, with_protocol_metadata
from app.core.url_security import resolve_pinned_ip

_LIST_TOOLS_MAX_PAGES = 8
_MAX_RESPONSE_BYTES = 2_000_000
_MAX_TOOL_DESCRIPTION_CHARS = 2_000
_MAX_LIST_TOOLS_BYTES = 1_000_000


class McpClientError(Exception):
    """携带人话文案与机器类别的 MCP 客户端错误。"""

    def __init__(self, message: str, kind: str = "protocol", *,
                 rpc_error: dict | None = None, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.code = rpc_error.get("code") if isinstance(rpc_error, dict) else None
        self.data = rpc_error.get("data") if isinstance(rpc_error, dict) else None
        self.status_code = status_code


def error_payload(exc: McpClientError) -> dict[str, str]:
    return {"error": exc.message, "error_kind": exc.kind}


class _LimitedHttpxStream(httpx2.AsyncByteStream):
    """将受信任的旧 HTTP transport 桥接给 SDK，并限制响应体大小。"""

    def __init__(self, response: httpx.Response, maximum: int):
        self._response = response
        self._maximum = maximum

    async def __aiter__(self):
        total = 0
        try:
            if self._response.is_stream_consumed:
                source = (self._response.content,)
            else:
                source = self._response.aiter_raw()
            async for chunk in _as_async_iterable(source):
                total += len(chunk)
                if total > self._maximum:
                    raise McpClientError(
                        f"MCP server 响应体超出防御上限 {self._maximum} 字节",
                        kind="protocol",
                    )
                yield chunk
        finally:
            await self._response.aclose()

    async def aclose(self) -> None:
        await self._response.aclose()


async def _read_capped_response(response: httpx.Response, maximum: int) -> bytes:
    if response.is_stream_consumed:
        body = response.content
        if len(body) > maximum:
            raise McpClientError("MCP server 响应体超出防御上限", kind="protocol")
        return body
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_raw():
        total += len(chunk)
        if total > maximum:
            raise McpClientError("MCP server 响应体超出防御上限", kind="protocol")
        chunks.append(chunk)
    return b"".join(chunks)


async def _as_async_iterable(source):
    if isinstance(source, tuple):
        for chunk in source:
            yield chunk
        return
    async for chunk in source:
        yield chunk


class _HttpxTransportBridge(httpx2.AsyncBaseTransport):
    """桥接到既有 DNS 固定 transport；协议与 SSE 由官方 SDK 负责。"""

    def __init__(self, transport: httpx.AsyncBaseTransport):
        self._transport = transport

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        body = await request.aread()
        legacy_request = httpx.Request(
            request.method, str(request.url), headers=dict(request.headers), content=body,
        )
        response = await self._transport.handle_async_request(legacy_request)
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise McpClientError("MCP server 返回了不允许跟随的 HTTP 重定向", kind="http",
                                 status_code=response.status_code)
        if response.status_code >= 400:
            status_code = response.status_code
            try:
                content = await _read_capped_response(response, _MAX_RESPONSE_BYTES)
            finally:
                await response.aclose()
            if status_code == 404:
                # SDK 的自动协商以 JSON-RPC method-not-found 作为旧协议探测信号。
                try:
                    payload = json.loads(content)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    payload = None
                if not (isinstance(payload, dict) and payload.get("jsonrpc") == "2.0"
                        and isinstance(payload.get("error"), dict)):
                    content = json.dumps({
                        "jsonrpc": "2.0", "id": _request_id(body),
                        "error": {"code": -32601, "message": "method not found"},
                    }).encode("utf-8")
                    headers = {"content-type": "application/json"}
                    return httpx2.Response(200, headers=headers, content=content, request=request)
            if status_code in {401, 403, 405} or status_code >= 500 or status_code == 429:
                raise _http_status_error(status_code)
            try:
                payload = json.loads(content)
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = None
            if not (isinstance(payload, dict) and payload.get("jsonrpc") == "2.0"
                    and isinstance(payload.get("error"), dict)):
                raise _http_status_error(status_code)
            # MCP 允许使用非 2xx 传递 JSON-RPC 错误；转成 SDK 可解析的成功 HTTP 包装。
            headers = {"content-type": "application/json"}
            return httpx2.Response(200, headers=headers, content=content, request=request)
        headers = dict(response.headers)
        return httpx2.Response(
            response.status_code,
            headers=headers,
            stream=_LimitedHttpxStream(response, _MAX_RESPONSE_BYTES),
            request=request,
        )

    async def aclose(self) -> None:
        await self._transport.aclose()


class McpClient:
    """单 server 的官方 SDK 客户端；一次实例对应一个 MCP 会话。"""

    def __init__(self, endpoint: str, headers: dict[str, str] | None = None,
                 query_params: dict[str, str] | None = None,
                 timeout_seconds: float = 30.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self._endpoint = endpoint
        self._headers = dict(headers or {})
        self._query_params = {str(k): str(v) for k, v in (query_params or {}).items()}
        self._timeout_seconds = float(timeout_seconds)
        self._provided_transport = transport
        self._supports_tasks = False

    async def __aenter__(self) -> "McpClient":
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        # 每个 SDK 会话都在调用它的同一任务中创建和关闭。
        self._supports_tasks = False

    async def initialize(self) -> dict:
        try:
            async with self._connected_client() as client:
                session = client.session
                discovery = session.discover_result
                initialized = session.initialize_result
                result = discovery or initialized
                return _model_dict(result) if result is not None else {}
        except McpClientError as exc:
            return error_payload(exc)
        except Exception as exc:
            return error_payload(_map_exception(exc, self._timeout_seconds))

    async def list_tools(self) -> dict:
        tools: list[dict] = []
        cursor: str | None = None
        total_bytes = 0
        try:
            async with self._connected_client() as client:
                for _page in range(_LIST_TOOLS_MAX_PAGES):
                    result = await client.list_tools(cursor=cursor)
                    for tool in result.tools:
                        item = _model_dict(tool)
                        description = item.get("description")
                        if isinstance(description, str) and len(description) > _MAX_TOOL_DESCRIPTION_CHARS:
                            item["description"] = description[:_MAX_TOOL_DESCRIPTION_CHARS] + "…（超长说明已截断）"
                        tools.append(item)
                        total_bytes += len(json.dumps(item, ensure_ascii=False))
                    if total_bytes > _MAX_LIST_TOOLS_BYTES:
                        return {"error": "tools/list 响应体积超出防御上限，已拒绝加载该 server 的工具",
                                "error_kind": "protocol"}
                    cursor = result.next_cursor
                    if not cursor:
                        break
                else:
                    return {"error": "工具列表分页异常，已到防御上限", "error_kind": "protocol"}
            return {"tools": tools}
        except Exception as exc:
            return error_payload(_map_exception(exc, self._timeout_seconds))

    async def call_tool(self, name: str, arguments: dict | None) -> dict:
        try:
            async with self._connected_client() as client:
                params: dict[str, Any] = {"name": name, "arguments": dict(arguments or {})}
                parameter_headers: dict[str, str] = {}
                result = await self._call_tool_rpc(client, params, parameter_headers)
                if result.get("resultType") == "task" and result.get("taskId"):
                    if not self._supports_tasks:
                        raise McpClientError("MCP server 返回了未协商的 Tasks 结果", kind="protocol")
                    from agent.mcp.tasks import wait_for_task

                    task_id = str(result["taskId"])
                    return await wait_for_task(
                        task_id, result,
                        request=lambda method, task_params: self._task_request(client.session, method, task_params),
                        cancel=lambda: self._task_request(client.session, "tasks/cancel", {"taskId": task_id}),
                    )
                return result
        except asyncio.CancelledError:
            from agent.runtime.cancellation import mark_remote_cancel_uncertain
            mark_remote_cancel_uncertain()
            raise
        except Exception as exc:
            return error_payload(_map_exception(exc, self._timeout_seconds))

    async def _call_tool_rpc(self, client: Client, params: dict,
                             parameter_headers: dict[str, str]) -> dict:
        payload = dict(params)
        if client.protocol_version == "2026-07-28":
            payload = with_protocol_metadata(payload, client.protocol_version)
        if self._supports_tasks:
            meta = dict(payload.get("_meta") or {})
            meta["io.modelcontextprotocol/clientCapabilities"] = {
                "extensions": {"io.modelcontextprotocol/tasks": {}}
            }
            payload["_meta"] = meta
        headers: dict[str, str] = {}
        if client.protocol_version == "2026-07-28":
            headers.update({
                "Mcp-Method": "tools/call",
                "Mcp-Name": encode_header_value(str(payload.get("name") or "")),
            })
        headers.update({f"Mcp-Param-{key}": value for key, value in parameter_headers.items()})
        try:
            # ClientSession 的高层 call_tool 会拒绝 Tasks 扩展结果；SDK 的
            # Dispatcher 是公开协议边界，仍由它处理请求 ID、取消、错误和传输。
            result = await client.session._dispatcher.send_raw_request(
                "tools/call", payload, {"headers": headers},
            )
        except MCPError as exc:
            raise _map_exception(exc, self._timeout_seconds) from exc
        if not isinstance(result, dict):
            raise McpClientError("MCP server 返回格式无效", kind="protocol")
        return result

    async def _task_request(self, session: ClientSession, method: str, params: dict) -> dict:
        if method not in {"tasks/get", "tasks/cancel"}:
            raise McpClientError("MCP Tasks 请求类型不受支持", kind="protocol")
        headers: dict[str, str] = {}
        version = session.protocol_version
        if version == "2026-07-28":
            params = with_protocol_metadata(params, version)
            headers.update({
                "Mcp-Method": method,
                "Mcp-Name": encode_header_value(str(params.get("taskId") or "")),
            })
        try:
            result = await session._dispatcher.send_raw_request(method, params, {
                "headers": headers,
                "cancel_on_abandon": False,
            })
        except MCPError as exc:
            raise _map_exception(exc, self._timeout_seconds) from exc
        return result if isinstance(result, dict) else {}

    @asynccontextmanager
    async def _connected_client(self):
        stack = AsyncExitStack()
        try:
            endpoint = self._request_url()
            transport = self._provided_transport
            if transport is None:
                pinned_ip, resolve_error = resolve_pinned_ip(self._endpoint)
                if not pinned_ip:
                    raise McpClientError(
                        resolve_error or "该地址不允许访问（仅放行公网地址）", kind="network",
                    )
                from app.core.pinned_http import PinnedHTTPTransport
                transport = PinnedHTTPTransport(pinned_ip)
            bridge = _HttpxTransportBridge(transport)
            http_client = httpx2.AsyncClient(
                headers=self._headers,
                timeout=httpx2.Timeout(self._timeout_seconds),
                follow_redirects=False,
                trust_env=False,
                transport=bridge,
            )
            await stack.enter_async_context(http_client)
            sdk_transport = streamable_http_client(
                endpoint, http_client=http_client, max_sse_event_size=_MAX_RESPONSE_BYTES,
            )
            client = Client(
                sdk_transport, read_timeout_seconds=self._timeout_seconds, mode="auto",
                client_info=mcp_types.Implementation(**_client_info()),
            )
            await stack.enter_async_context(client)
            discovery = client.session.discover_result
            self._supports_tasks = advertises_tasks(_model_dict(discovery) if discovery else {})
            yield client
        finally:
            await stack.aclose()

    def _request_url(self) -> str:
        if not self._query_params:
            return self._endpoint
        parts = urlsplit(self._endpoint)
        names = set(self._query_params)
        query = [item for item in parse_qsl(parts.query, keep_blank_values=True) if item[0] not in names]
        query.extend(self._query_params.items())
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _model_dict(value: Any) -> dict:
    if value is None:
        return {}
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return value
    return {}


def _client_info() -> dict[str, str]:
    from agent.mcp.models import CLIENT_INFO
    return dict(CLIENT_INFO)


def _request_id(body: bytes) -> Any:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload.get("id") if isinstance(payload, dict) else None


def _http_status_error(status_code: int) -> McpClientError:
    if status_code in {401, 403}:
        return McpClientError(f"MCP server 认证失败（HTTP {status_code}），请检查凭据配置",
                              kind="auth", status_code=status_code)
    if status_code == 405:
        return McpClientError(
            "服务器不支持 Streamable HTTP MCP，请检查服务端点与传输类型",
            kind="configuration", status_code=status_code,
        )
    return McpClientError(f"MCP server HTTP 请求失败（HTTP {status_code}）", kind="http",
                          status_code=status_code)


def _map_exception(exc: Exception, timeout_seconds: float) -> McpClientError:
    if isinstance(exc, BaseExceptionGroup):
        mapped = [_map_exception(item, timeout_seconds) for item in exc.exceptions]
        # TaskGroup 包装异常时保留最具体、最有用的一项底层错误。
        return next((item for item in mapped if item.kind != "protocol"), mapped[0])
    if isinstance(exc, McpClientError):
        return exc
    if isinstance(exc, asyncio.TimeoutError) or isinstance(exc, (httpx.TimeoutException, httpx2.TimeoutException)):
        return McpClientError(
            f"MCP server 响应超时（>{int(timeout_seconds)}s），请稍后重试或在设置里调大超时",
            kind="timeout",
        )
    if isinstance(exc, (httpx.NetworkError, httpx2.NetworkError, OSError)):
        return McpClientError("无法连接 MCP server，请检查地址与网络", kind="network")
    if isinstance(exc, MCPError):
        if "timed out" in (exc.message or "").lower() or "timeout" in (exc.message or "").lower():
            return McpClientError(
                f"MCP server 响应超时（>{int(timeout_seconds)}s），请稍后重试或在设置里调大超时",
                kind="timeout", status_code=None,
            )
        data = {"code": exc.code, "data": exc.data}
        return McpClientError(f"MCP server 协议错误：{exc.message or '未知错误'}", kind="protocol",
                              rpc_error=data)
    status_code = getattr(exc, "status_code", None)
    if status_code is not None:
        return _http_status_error(status_code)
    if isinstance(exc, (httpx2.InvalidURL, httpx.InvalidURL)):
        return McpClientError("MCP 请求配置无效，请检查 HTTP Header 名称和凭据格式",
                              kind="configuration")
    if isinstance(exc, (httpx2.HTTPError, httpx.HTTPError)):
        return McpClientError("MCP server HTTP 请求失败，请检查服务状态与网络", kind="http")
    if isinstance(exc, (UnicodeError, httpx.InvalidURL, httpx2.InvalidURL)):
        return McpClientError("MCP 请求配置无效，请检查 HTTP Header 名称和凭据格式", kind="configuration")
    message = str(exc).strip()
    if "status code 401" in message or "HTTP 401" in message:
        return McpClientError("MCP server 认证失败（HTTP 401），请检查凭据配置", kind="auth")
    if "status code 403" in message or "HTTP 403" in message:
        return McpClientError("MCP server 认证失败（HTTP 403），请检查凭据配置", kind="auth")
    return McpClientError("MCP server 请求失败，请检查服务状态与协议配置", kind="protocol")
