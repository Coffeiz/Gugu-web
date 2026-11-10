"""GitHub 专用 MCP 兼容行为及标准 MCP 隔离测试。"""
import json

import httpx
import pytest

from agent.mcp.client import McpClient
from agent.mcp.github import create_github_aware_client
from agent.mcp.github.compat import GithubCopilotMcpClient
from agent.mcp.models import MCP_MODERN_PROTOCOL_VERSION


def _mock_server(require_parameter_headers: bool = False):
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        headers = dict(request.headers)
        requests.append((payload, headers))
        if payload.get("method") == "server/discover":
            body = {
                "jsonrpc": "2.0", "id": payload["id"],
                "result": {"supportedVersions": [MCP_MODERN_PROTOCOL_VERSION],
                           "capabilities": {}},
            }
        elif require_parameter_headers:
            args = payload["params"]["arguments"]
            missing = next((key for key in ("owner", "repo") if key in args
                            if headers.get(f"mcp-param-{key}") != args[key]), None)
            if missing:
                body = {
                    "jsonrpc": "2.0", "id": payload["id"],
                    "error": {"code": -32602, "message": (
                        f'header mismatch: missing Mcp-Param-{missing} header '
                        f'for parameter "{missing}"'
                    )},
                }
            else:
                body = {"jsonrpc": "2.0", "id": payload["id"],
                        "result": {"content": [{"type": "text", "text": "ok"}]}}
        else:
            body = {"jsonrpc": "2.0", "id": payload["id"],
                    "result": {"content": [{"type": "text", "text": "ok"}]}}
        return httpx.Response(200, json=body)

    return requests, httpx.MockTransport(handler)


def test_factory_selects_github_adapter_only_for_official_endpoint():
    github = create_github_aware_client("https://api.githubcopilot.com/mcp/")
    ordinary = create_github_aware_client("https://maps.example.net/mcp/")
    lookalike = create_github_aware_client("https://api.githubcopilot.com.example.net/mcp/")

    assert isinstance(github, GithubCopilotMcpClient)
    assert type(ordinary) is McpClient
    assert type(lookalike) is McpClient


@pytest.mark.asyncio
async def test_github_adapter_retries_requested_headers_incrementally():
    requests, transport = _mock_server(require_parameter_headers=True)
    client = create_github_aware_client(
        "https://api.githubcopilot.com/mcp/", transport=transport,
    )

    result = await client.call_tool("list_branches", {"owner": "openai", "repo": "codex"})

    assert result["content"][0]["text"] == "ok"
    calls = [(payload, headers) for payload, headers in requests
             if payload.get("method") == "tools/call"]
    assert len(calls) == 3
    assert calls[0][1].get("mcp-param-owner") is None
    assert calls[1][1]["mcp-param-owner"] == "openai"
    assert calls[1][1].get("mcp-param-repo") is None
    assert calls[2][1]["mcp-param-owner"] == "openai"
    assert calls[2][1]["mcp-param-repo"] == "codex"
    assert all(payload["params"]["arguments"] == {"owner": "openai", "repo": "codex"}
               for payload, _headers in calls)


@pytest.mark.asyncio
async def test_non_github_mcp_does_not_retry_or_add_github_headers():
    requests, transport = _mock_server(require_parameter_headers=True)
    client = create_github_aware_client("https://maps.example.net/mcp/", transport=transport)

    result = await client.call_tool("search", {"owner": "openai", "repo": "codex"})

    assert "Mcp-Param-owner" in result["error"]
    calls = [(payload, headers) for payload, headers in requests
             if payload.get("method") == "tools/call"]
    assert len(calls) == 1
    assert not any(key.lower().startswith("mcp-param-") for key in calls[0][1])


@pytest.mark.asyncio
async def test_github_adapter_does_not_retry_unrelated_errors_or_unsafe_values():
    requests, transport = _mock_server(require_parameter_headers=True)
    client = GithubCopilotMcpClient(
        "https://api.githubcopilot.com/mcp/", transport=transport,
    )

    unsafe = await client.call_tool("list_branches", {"repo": "bad\nvalue"})
    assert "Mcp-Param-repo" in unsafe["error"]
    calls = [(payload, headers) for payload, headers in requests
             if payload.get("method") == "tools/call"]
    assert len(calls) == 1
    assert not any(key.lower().startswith("mcp-param-") for key in calls[0][1])
