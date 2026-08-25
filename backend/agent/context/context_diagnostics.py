"""Canonical Context 的脱敏诊断工具。"""
from __future__ import annotations

from typing import Any

from .cache_policy import cache_capabilities
from .canonical_context import digest
from .canonical_request import CanonicalRequest


def first_diff_index(previous: list[dict], current: list[dict]) -> int | None:
    for index, (before, after) in enumerate(zip(previous, current)):
        if digest(before) != digest(after):
            return index
    return min(len(previous), len(current)) if len(previous) != len(current) else None


def request_diagnostics(messages: Any, *, system_text: str, tools: list[dict],
                        adapter: Any, model: str, api_format: str = "unknown",
                        previous_messages: list[dict] | None = None) -> dict[str, Any]:
    context = getattr(messages, "canonical_context", None)
    if context is None:
        return {"available": False}
    request = CanonicalRequest(
        context=context,
        tools=tuple(tools or ()),
        provider=str(getattr(adapter, "name", "unknown") or "unknown"),
        api_format=api_format,
        model=model,
    )
    result = request.diagnostics()
    result["cache_capabilities"] = cache_capabilities(adapter, model).__dict__
    result["system_digest"] = digest(system_text)
    wire = adapter.render_history(messages)
    result["wire_digest"] = digest(wire)
    result["wire_message_count"] = len(wire)
    result["first_diff_index"] = (
        first_diff_index(previous_messages, list(messages))
        if previous_messages is not None else None
    )
    return result
