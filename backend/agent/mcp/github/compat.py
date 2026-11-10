"""GitHub Copilot MCP 的 HTTP 参数头兼容逻辑。"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from agent.mcp.client import McpClient, McpClientError

_GITHUB_COPILOT_HOSTS = frozenset({"api.githubcopilot.com"})
_MISSING_PARAMETER_HEADER = re.compile(
    r'header mismatch: missing Mcp-Param-([A-Za-z0-9_-]+) header '
    r'for parameter "([A-Za-z0-9_-]+)"',
    re.IGNORECASE,
)
_MAX_PARAMETER_HEADER_VALUE = 255
_MAX_PARAMETER_HEADER_RETRIES = 16


def is_github_copilot_endpoint(endpoint: str) -> bool:
    """Match only GitHub's official Copilot MCP host, never lookalike domains."""
    try:
        return (urlsplit(endpoint).hostname or "").casefold() in _GITHUB_COPILOT_HOSTS
    except ValueError:
        return False


class GithubCopilotMcpClient(McpClient):
    """按 GitHub Copilot MCP 的明确缺头错误逐项补 HTTP 参数头后重试。"""

    async def _call_tool_rpc(self, client, params: dict, parameter_headers: dict[str, str]) -> dict:
        arguments = params.get("arguments")
        if not isinstance(arguments, dict):
            return await super()._call_tool_rpc(client, params, parameter_headers)

        attempted_parameters: set[str] = set()
        max_attempts = min(len(arguments) + 1, _MAX_PARAMETER_HEADER_RETRIES + 1)
        for _attempt in range(max_attempts):
            try:
                return await super()._call_tool_rpc(client, params, parameter_headers)
            except McpClientError as exc:
                match = _MISSING_PARAMETER_HEADER.search(exc.message)
                if match is None:
                    raise
                header_name, parameter_name = match.groups()
                value = arguments.get(parameter_name)
                if (header_name.casefold() != parameter_name.casefold()
                        or parameter_name in attempted_parameters
                        or not isinstance(value, str)
                        or not value.isascii()
                        or len(value) > _MAX_PARAMETER_HEADER_VALUE
                        or any(not (" " <= char <= "~") for char in value)):
                    raise
                attempted_parameters.add(parameter_name)
                parameter_headers[parameter_name] = value

        raise McpClientError(
            "GitHub MCP 连续要求过多参数头，已停止重试", kind="protocol",
        )
