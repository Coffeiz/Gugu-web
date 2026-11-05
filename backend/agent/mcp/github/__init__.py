"""GitHub MCP 服务的兼容适配。"""

from agent.mcp.client import McpClient
from agent.mcp.github.compat import GithubCopilotMcpClient, is_github_copilot_endpoint


def create_github_aware_client(endpoint: str, **client_kwargs) -> McpClient:
    """仅为 GitHub Copilot MCP 端点创建专用客户端，其余服务使用标准客户端。"""
    if is_github_copilot_endpoint(endpoint):
        return GithubCopilotMcpClient(endpoint, **client_kwargs)
    return McpClient(endpoint, **client_kwargs)


__all__ = ["create_github_aware_client", "GithubCopilotMcpClient"]
