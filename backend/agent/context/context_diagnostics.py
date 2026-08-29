"""Canonical Context 的脱敏诊断工具。"""
from __future__ import annotations

from typing import Any

from .cache_policy import cache_capabilities
from .canonical_context import digest
from .canonical_request import CanonicalRequest
from .tokens import estimate_tokens, message_text


def first_diff_index(previous: list[dict], current: list[dict]) -> int | None:
    for index, (before, after) in enumerate(zip(previous, current)):
        if digest(before) != digest(after):
            return index
    return min(len(previous), len(current)) if len(previous) != len(current) else None


def _representation_kind(message: dict[str, Any]) -> str:
    """只标记消息外层表示，不记录正文，帮助定位包装/role 变化。"""
    content = message.get("content")
    if isinstance(content, str):
        value = content.lstrip()
        if value.startswith("<compacted-summary>"):
            return "compacted-summary"
        if value.startswith("## 早前对话摘要"):
            return "legacy-summary-header"
        if value.startswith("[system-reminder]"):
            return "system-reminder-text"
        return "text"
    if isinstance(content, list):
        return "blocks"
    return type(content).__name__


def first_diff_reason(previous: dict[str, Any], current: dict[str, Any]) -> str:
    """返回首个变化消息的脱敏原因分类。"""
    previous_shape = _wire_message_shape(previous)
    current_shape = _wire_message_shape(current)
    if previous_shape["role"] != current_shape["role"]:
        return "role_changed"
    if previous_shape["representation"] != current_shape["representation"]:
        return "wrapper_changed"
    if previous_shape["block_shapes"] != current_shape["block_shapes"]:
        return "block_shape_changed"
    if previous_shape["content_kind"] != current_shape["content_kind"]:
        return "content_kind_changed"
    return "content_changed"


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
        "representation": _representation_kind(message),
        "content_kind": content_kind,
        "content_count": content_count,
        "block_shapes": blocks,
        "has_tool_calls": bool(message.get("tool_calls")),
        "has_tool_call_id": bool(message.get("tool_call_id")),
    }


def _wire_message_diagnostics(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按消息输出 digest 和结构，供跨 run 顺序对比。"""
    cumulative_tokens = 0
    result = []
    for index, message in enumerate(messages):
        message_tokens = estimate_tokens(message_text(message))
        cumulative_tokens += message_tokens
        result.append({
            "index": index,
            "digest": digest(message),
            "shape": _wire_message_shape(message),
            "token_estimate": message_tokens,
            "cumulative_token_estimate": cumulative_tokens,
        })
    return result


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
    result["wire_conversation_message_count"] = len(wire)
    result["wire_turn_batch_count"] = 0
    result["wire_total_token_estimate"] = (
        wire_diagnostics[-1]["cumulative_token_estimate"] if wire_diagnostics else 0
    )
    result["wire_role_sequence_digest"] = digest(
        [item["shape"]["role"] for item in wire_diagnostics]
    )
    result["wire_message_diagnostics"] = wire_diagnostics
    if previous_messages is not None:
        previous_wire = list(previous_messages)
        diff_index = first_diff_index(previous_wire, wire)
        result["first_diff_index"] = diff_index
        result["prefix_integrity"] = {
            "stable": diff_index is None,
            "previous_digest": digest(previous_wire[:diff_index]) if diff_index is not None else digest(previous_wire),
            "current_digest": digest(wire[:diff_index]) if diff_index is not None else digest(wire),
        }
        result["first_diff"] = {
            "index": diff_index,
            "reason": (
                first_diff_reason(previous_wire[diff_index], wire[diff_index])
                if diff_index is not None
                and diff_index < len(previous_wire)
                and diff_index < len(wire)
                else "message_count_changed"
            ),
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
        result["prefix_integrity"] = None
        result["first_diff"] = None
    return result
