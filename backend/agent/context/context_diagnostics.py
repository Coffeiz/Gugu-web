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


def _wire_message_shape(message: dict[str, Any]) -> dict[str, Any]:
    """返回消息的脱敏结构，不包含正文、工具参数或附件地址。"""
    role = str(message.get("role") or "")
    content = message.get("content")
    if isinstance(content, list):
        blocks = []
        for block in content:
            if isinstance(block, dict):
                blocks.append({
                    "type": str(block.get("type") or ""),
                    "keys": sorted(str(key) for key in block.keys()),
                })
            else:
                blocks.append({"type": type(block).__name__})
        content_kind = "blocks"
        content_count = len(content)
    else:
        blocks = []
        content_kind = type(content).__name__
        content_count = 1 if content is not None else 0
    return {
        "role": role,
        "content_kind": content_kind,
        "content_count": content_count,
        "block_shapes": blocks,
        "has_tool_calls": bool(message.get("tool_calls")),
        "has_tool_call_id": bool(message.get("tool_call_id")),
    }


def _wire_message_diagnostics(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按消息输出 digest 和结构，供跨 run 顺序对比。"""
    return [
        {
            "index": index,
            "digest": digest(message),
            "shape": _wire_message_shape(message),
        }
        for index, message in enumerate(messages)
    ]


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
    wire = list(adapter.render_history(messages))
    result["wire_digest"] = digest(wire)
    result["wire_message_count"] = len(wire)
    wire_diagnostics = _wire_message_diagnostics(wire)
    result["wire_role_sequence_digest"] = digest(
        [item["shape"]["role"] for item in wire_diagnostics]
    )
    result["wire_message_diagnostics"] = wire_diagnostics
    if previous_messages is not None:
        previous_wire = list(previous_messages)
        diff_index = first_diff_index(previous_wire, wire)
        result["first_diff_index"] = diff_index
        result["first_diff"] = {
            "index": diff_index,
            "previous": (
                _wire_message_diagnostics(previous_wire)[diff_index]
                if diff_index is not None and diff_index < len(previous_wire) else None
            ),
            "current": (
                wire_diagnostics[diff_index]
                if diff_index is not None and diff_index < len(wire_diagnostics) else None
            ),
        }
    else:
        result["first_diff_index"] = None
        result["first_diff"] = None
    return result
