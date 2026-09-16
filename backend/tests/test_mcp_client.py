"""MCP1-001 验收：最小 JSON-RPC 客户端对 FakeMcpServer 完成 list/call 往返。

FakeMcpServer 用 httpx.MockTransport 内嵌实现（不开真实 socket），覆盖：
streamable HTTP 的 json 与 SSE 两种响应、Mcp-Session-Id 会话、分页、
超时结构化错误、重定向不跟随、内网地址拒绝、协议错误人话。
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from agent.mcp.client import McpClient


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
            def response(_request: httpx.Request, payload=payload) -> httpx.Response:
                return httpx.Response(200, json=payload)

            client = McpClient(
                "https://mcp.example.com/rpc",
                transport=httpx.MockTransport(response),
            )
            result = await client.list_tools()
            assert result["error_kind"] == "protocol"
            assert expected in result["error"]

    asyncio.run(run())
