"""MCP1-001 验收：最小 JSON-RPC 客户端对 FakeMcpServer 完成 list/call 往返。

FakeMcpServer 用 httpx.MockTransport 内嵌实现（不开真实 socket），覆盖：
streamable HTTP 的 json 与 SSE 两种响应、Mcp-Session-Id 会话、分页、
超时结构化错误、重定向不跟随、内网地址拒绝、协议错误人话。
"""
from __future__ import annotations

import asyncio
import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from agent.mcp.client import McpClient
from agent.mcp.models import MCP_MODERN_PROTOCOL_VERSION, MCP_TASKS_EXTENSION


class FakeMcpServer:
    """进程内 MCP server 桩：记录 initialize 会话，按方法返回固定结果。"""

    def __init__(self, *, sse: bool = False, session: bool = True,
                 tools: list[dict] | None = None, call_result: dict | None = None,
                 paged: bool = False):
        self.sse = sse
        self.session = session
        self.tools = tools if tools is not None else [
            {"name": "echo", "description": "回声测试\n第二行", "inputSchema": {"type": "object", "properties": {}}}
        ]
        self.call_result = call_result or {"content": [{"type": "text", "text": "pong"}], "isError": False}
        self.paged = paged
        self.requests: list[dict] = []
        self.session_id = "sess-123"

    def _body(self, payload: dict, request_id) -> dict:
        method = payload.get("method")
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake"}}
        elif method == "tools/list":
            if self.paged:
                cursor = payload.get("params", {}).get("cursor")
                if not cursor:
                    result = {"tools": self.tools[:1], "nextCursor": "page-2"}
                else:
                    result = {"tools": self.tools[1:]}
            else:
                result = {"tools": self.tools}
        elif method == "tools/call":
            result = self.call_result
        else:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "未知方法"}}
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def transport(self) -> httpx.MockTransport:
        server = self

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content.decode("utf-8"))
            server.requests.append(payload)
            request_id = payload.get("id")
            if request_id is None:                      # notification
                return httpx.Response(202)
            body = server._body(payload, request_id)
            headers = {"Mcp-Session-Id": server.session_id} if server.session else {}
            if server.sse:
                text = f"data: {json.dumps(body)}\n\n"
                return httpx.Response(200, headers={**headers, "Content-Type": "text/event-stream"}, text=text)
            return httpx.Response(200, headers={**headers, "Content-Type": "application/json"}, json=body)

        return httpx.MockTransport(handler)


def _client(server: FakeMcpServer, **kwargs) -> McpClient:
    return McpClient("https://mcp.example.com/rpc", transport=server.transport(), **kwargs)


def test_list_and_call_roundtrip_json():
    async def run():
        server = FakeMcpServer()
        async with _client(server) as client:
            tools = await client.list_tools()
            assert "error" not in tools
            assert [t["name"] for t in tools["tools"]] == ["echo"]
            assert any(r["method"] == "initialize" for r in server.requests)
            assert any(r["method"] == "notifications/initialized" for r in server.requests)

            result = await client.call_tool("echo", {"msg": "hi"})
            assert result["content"][0]["text"] == "pong"

    asyncio.run(run())


@pytest.mark.asyncio
async def test_tasks_extension_is_polled_and_cancelled_with_task_routing_headers():
    requests = []
    task_poll = asyncio.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        method = payload.get("method")
        requests.append((payload, dict(request.headers)))
        if method == "server/discover":
            result = {"resultType": "complete", "supportedVersions": [MCP_MODERN_PROTOCOL_VERSION],
                      "capabilities": {"tools": {}, "extensions": {MCP_TASKS_EXTENSION: {}}}}
        elif method == "tools/call":
            assert payload["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"]["extensions"] == {
                MCP_TASKS_EXTENSION: {},
            }
            result = {"resultType": "task", "taskId": "task-7", "status": "working", "pollIntervalMs": 100}
        elif method == "tasks/get":
            task_poll.set()
            result = {"resultType": "complete", "taskId": "task-7", "status": "working", "pollIntervalMs": 100}
        elif method == "tasks/cancel":
            result = {}
        else:
            return httpx.Response(202)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": payload["id"], "result": result})

    client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(handler))
    call = asyncio.create_task(client.call_tool("slow", {}))
    await asyncio.wait_for(task_poll.wait(), timeout=1)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    cancel = next((headers for payload, headers in requests if payload.get("method") == "tasks/cancel"), None)
    assert cancel is not None
    assert cancel.get("mcp-name") == "task-7"
    assert cancel.get("mcp-method") == "tasks/cancel"
    modern_requests = [payload for payload, _ in requests]
    assert all(
        payload.get("params", {}).get("_meta", {}).get("io.modelcontextprotocol/protocolVersion")
        == MCP_MODERN_PROTOCOL_VERSION
        for payload in modern_requests
    )
    call_headers = next(headers for payload, headers in requests if payload.get("method") == "tools/call")
    assert call_headers.get("mcp-protocol-version") == MCP_MODERN_PROTOCOL_VERSION
    assert call_headers.get("mcp-method") == "tools/call"
    assert call_headers.get("mcp-name") == "slow"
    assert not any(payload.get("method") == "notifications/cancelled" for payload, _ in requests)


@pytest.mark.asyncio
async def test_legacy_server_uses_initialize_and_does_not_advertise_new_tasks_extension():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        requests.append(payload)
        if payload.get("method") == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {}}
        elif payload.get("method") == "tools/call":
            result = {"content": [{"type": "text", "text": "legacy"}], "isError": False}
        else:
            response = {"jsonrpc": "2.0", "id": payload.get("id"),
                        "error": {"code": -32601, "message": "method not found"}}
            return httpx.Response(200, json=response)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": payload["id"], "result": result})

    client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(handler))
    assert (await client.initialize())["protocolVersion"] == "2025-06-18"
    assert (await client.call_tool("echo", {}))["content"][0]["text"] == "legacy"
    call = next(payload for payload in requests if payload.get("method") == "tools/call")
    assert "_meta" not in call["params"]
    assert [payload["method"] for payload in requests[:3]] == [
        "server/discover", "initialize", "notifications/initialized",
    ]


@pytest.mark.asyncio
async def test_legacy_http_endpoint_with_non_rpc_404_falls_back_to_initialize():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        requests.append(payload)
        if payload.get("method") == "server/discover":
            return httpx.Response(404, text="legacy endpoint")
        if payload.get("method") == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {}}
        else:
            return httpx.Response(202)
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": payload["id"], "result": result})

    client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(handler))
    result = await client.initialize()

    assert result["protocolVersion"] == "2025-06-18"
    assert [payload["method"] for payload in requests] == [
        "server/discover", "initialize", "notifications/initialized",
    ]


@pytest.mark.asyncio
async def test_modern_http_protocol_error_is_not_misidentified_as_legacy():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        requests.append(payload)
        return httpx.Response(400, json={
            "jsonrpc": "2.0", "id": payload["id"],
            "error": {
                "code": -32022, "message": "Unsupported protocol version",
                "data": {"supported": ["2025-11-25"], "requested": MCP_MODERN_PROTOCOL_VERSION},
            },
        })

    client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(handler))
    result = await client.initialize()

    assert result["error_kind"] == "protocol"
    assert "Unsupported protocol version" in result["error"]
    assert [payload["method"] for payload in requests] == ["server/discover"]


@pytest.mark.asyncio
async def test_modern_server_without_tasks_capability_gets_regular_tool_call():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        requests.append((payload, dict(request.headers)))
        if payload.get("method") == "server/discover":
            result = {"resultType": "complete", "supportedVersions": [MCP_MODERN_PROTOCOL_VERSION],
                      "capabilities": {"tools": {}}}
        else:
            result = {"content": [{"type": "text", "text": "ordinary"}], "isError": False}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": payload["id"], "result": result})

    client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(handler))
    result = await client.call_tool("read", {})

    assert result["content"][0]["text"] == "ordinary"
    call, headers = next((payload, headers) for payload, headers in requests
                         if payload.get("method") == "tools/call")
    capabilities = call["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"]
    assert MCP_TASKS_EXTENSION not in capabilities.get("extensions", {})
    assert headers["mcp-protocol-version"] == MCP_MODERN_PROTOCOL_VERSION


def test_sse_response_and_session_header():
    async def run():
        server = FakeMcpServer(sse=True)
        seen: list[str | None] = []
        original = server.transport().handler

        def spy(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("Mcp-Session-Id"))
            return original(request)

        transport = httpx.MockTransport(spy)
        async with McpClient("https://mcp.example.com/rpc", transport=transport) as client:
            tools = await client.list_tools()
            assert "error" not in tools
        # 首个 initialize 请求无会话 id，后续请求带上服务端签发的会话
        assert seen[0] is None
        assert any(h == "sess-123" for h in seen[1:])

    asyncio.run(run())


def test_paged_tools_list():
    async def run():
        server = FakeMcpServer(paged=True, tools=[{"name": "a"}, {"name": "b"}])
        async with _client(server) as client:
            tools = await client.list_tools()
            assert [t["name"] for t in tools["tools"]] == ["a", "b"]

    asyncio.run(run())


def test_timeout_and_network_errors_mapped():
    """MockTransport 不走真实 socket 超时，这里验证异常→结构化错误的映射。"""
    async def run():
        def timeout_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("timed out", request=request)

        client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(timeout_handler))
        result = await client.list_tools()
        assert "error" in result
        assert "超时" in result["error"]
        assert result["error_kind"] == "timeout"

        def connect_error(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(connect_error))
        result = await client.call_tool("echo", {})
        assert "error" in result
        assert "无法连接" in result["error"]
        assert result["error_kind"] == "network"

    asyncio.run(run())


def test_redirect_not_followed():
    async def run():
        server = FakeMcpServer()

        def redirect(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"Location": "https://evil.example.com/rpc"})

        client = McpClient("https://mcp.example.com/rpc", transport=httpx.MockTransport(redirect))
        result = await client.list_tools()
        assert "error" in result
        assert result["error_kind"] == "http"

    asyncio.run(run())


def test_protocol_error_humanized():
    async def run():
        cases = [
            (
                {"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "method not found"}},
                "method not found",
            ),
            (
                {"jsonrpc": "2.0", "id": 999, "result": {"tools": []}},
                "不匹配",
            ),
        ]
        for payload, expected in cases:
            def response(request: httpx.Request, payload=payload) -> httpx.Response:
                request_body = json.loads(request.content.decode("utf-8"))
                if request_body.get("method") == "server/discover" and "error" in payload:
                    response_payload = {**payload, "id": request_body["id"]}
                else:
                    response_payload = {**payload}
                    if "error" in response_payload:
                        response_payload["id"] = request_body["id"]
                return httpx.Response(200, json=response_payload)

            client = McpClient(
                "https://mcp.example.com/rpc",
                transport=httpx.MockTransport(response),
            )
            result = await client.list_tools()
            assert result["error_kind"] == "protocol"
            assert expected in result["error"]

    asyncio.run(run())


def test_numeric_request_id_can_match_string_response_id():
    """兼容少数把 JSON-RPC 数字 id 序列化为字符串的 MCP 服务。"""
    async def run():
        def response(request: httpx.Request) -> httpx.Response:
            request_body = json.loads(request.content.decode("utf-8"))
            request_id = request_body.get("id")
            if request_body.get("method") == "server/discover":
                result = {"resultType": "complete", "supportedVersions": [MCP_MODERN_PROTOCOL_VERSION],
                          "capabilities": {"tools": {}}}
            else:
                result = {"tools": []}
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": str(request_id), "result": result},
            )

        client = McpClient(
            "https://mcp.example.com/rpc",
            transport=httpx.MockTransport(response),
        )
        result = await client.list_tools()
        assert result == {"tools": []}

    asyncio.run(run())


def test_provider_json_error_is_not_reported_as_id_mismatch():
    async def run():
        def response(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"status": "0", "info": "INVALID_USER_KEY", "infocode": "10001"},
            )

        client = McpClient(
            "https://mcp.example.com/rpc",
            transport=httpx.MockTransport(response),
        )
        result = await client.list_tools()
        assert result["error_kind"] == "http"
        assert "INVALID_USER_KEY" in result["error"]
        assert "不匹配" not in result["error"]

    asyncio.run(run())


def test_query_credentials_are_added_only_to_request_url():
    async def run():
        seen_urls: list[str] = []

        def response(request: httpx.Request) -> httpx.Response:
            seen_urls.append(str(request.url))
            request_id = json.loads(request.content.decode("utf-8")).get("id")
            method = json.loads(request.content.decode("utf-8")).get("method")
            result = (
                {"resultType": "complete", "supportedVersions": [MCP_MODERN_PROTOCOL_VERSION],
                 "capabilities": {"tools": {}}}
                if method == "server/discover" else {"tools": []}
            )
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": request_id, "result": result},
            )

        client = McpClient(
            "https://mcp.example.com/mcp?region=cn&key=stale-value",
            query_params={"key": "secret-value"},
            transport=httpx.MockTransport(response),
        )
        assert await client.list_tools() == {"tools": []}
        assert parse_qs(urlsplit(seen_urls[0]).query) == {
            "region": ["cn"], "key": ["secret-value"],
        }

    asyncio.run(run())


def test_invalid_header_credentials_are_structured_and_secret_safe():
    async def run():
        secret = "Bearer 测试凭据"
        client = McpClient(
            "https://mcp.example.com/rpc",
            headers={"Authorization": secret},
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})),
        )
        result = await client.list_tools()
        assert result["error_kind"] == "configuration"
        assert "Header" in result["error"]
        assert secret not in result["error"]

    asyncio.run(run())


def test_http_405_is_reported_as_endpoint_configuration_error():
    async def run():
        client = McpClient(
            "https://mcp.example.com/rpc",
            transport=httpx.MockTransport(lambda _request: httpx.Response(405)),
        )
        result = await client.list_tools()
        assert result["error_kind"] == "configuration"
        assert "Streamable HTTP MCP" in result["error"]

    asyncio.run(run())
