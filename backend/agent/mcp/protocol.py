"""共享的 MCP 双协议元数据与能力协商规则。"""
from __future__ import annotations

from typing import Any

from agent.mcp.models import CLIENT_INFO, MCP_TASKS_EXTENSION


def with_protocol_metadata(params: dict[str, Any], protocol_version: str) -> dict[str, Any]:
    """为现代 MCP 请求生成协议必需的 per-request 元数据。"""
    result = dict(params)
    meta = dict(result.get("_meta") or {})
    meta.update({
        "io.modelcontextprotocol/protocolVersion": protocol_version,
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    })
    meta.setdefault("io.modelcontextprotocol/clientCapabilities", {})
    result["_meta"] = meta
    return result


def is_legacy_probe_error(
    *, transport: str, kind: str, code: int | None, status_code: int | None = None,
) -> bool:
    """区分旧服务端探测失败与现代 MCP 的结构化错误。"""
    if code in {-32020, -32021, -32022}:
        return False
    if transport == "http" and code == -32601 and status_code == 404:
        return False
    if kind in {"network", "timeout", "auth"}:
        return False
    if transport == "http" and status_code is not None:
        return status_code in {400, 404, 405}
    return kind == "protocol"


def advertises_tasks(discovery_result: dict[str, Any]) -> bool:
    capabilities = discovery_result.get("capabilities")
    extensions = capabilities.get("extensions") if isinstance(capabilities, dict) else None
    return isinstance(extensions, dict) and MCP_TASKS_EXTENSION in extensions
