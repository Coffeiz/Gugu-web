"""Canonical Context 到 provider 请求之间的稳定请求描述。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .canonical_context import CanonicalContext, digest


def stable_tool_schemas(tools: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> tuple[dict[str, Any], ...]:
    """按工具名和完整 schema digest 排序，避免注册顺序造成诊断断点漂移。"""
    return tuple(sorted(
        (dict(tool) for tool in tools),
        key=lambda tool: (str(tool.get("name") or tool.get("function", {}).get("name") or ""), digest(tool)),
    ))


@dataclass(frozen=True)
class CanonicalRequest:
    context: CanonicalContext
    tools: tuple[dict[str, Any], ...] = ()
    provider: str = "unknown"
    api_format: str = "unknown"
    model: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "tools", stable_tool_schemas(self.tools))

    @property
    def tool_schema_digest(self) -> str:
        return digest(self.tools)

    @property
    def canonical_digest(self) -> str:
        return digest({
            "context": self.context.canonical_digest,
            "tool_schema_digest": self.tool_schema_digest,
            "provider": self.provider,
            "api_format": self.api_format,
            "model": self.model,
        })

    def diagnostics(self) -> dict[str, Any]:
        return {
            "canonical_digest": self.canonical_digest,
            "context": self.context.diagnostics(),
            "provider": self.provider,
            "api_format": self.api_format,
            "model": self.model,
            "tool_count": len(self.tools),
            "tool_schema_digest": self.tool_schema_digest,
        }
