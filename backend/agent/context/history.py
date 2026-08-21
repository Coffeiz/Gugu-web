"""把持久化的会话历史转换成 provider 可接受的消息结构。"""
from __future__ import annotations

import json
from typing import Iterable

from .tokens import content_text


def _blocks(value) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _openai_tool_call(block: dict) -> dict:
    arguments = block.get("arguments", block.get("input", {}))
    if not isinstance(arguments, str):
        arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
    return {
        "id": str(block.get("id") or block.get("tool_use_id") or "tool-call"),
        "type": "function",
        "function": {
            "name": str(block.get("name") or "unknown_tool"),
            "arguments": arguments,
        },
    }


def _canonical_block(block: dict) -> dict | None:
    """把 Anthropic/OpenAI 工具块归一为 provider-neutral 结构。"""
    block_type = block.get("type")
    if block_type in ("tool_use", "tool_call"):
        arguments = block.get("arguments", block.get("input", {}))
        return {
            "type": "tool_call",
            "id": str(block.get("id") or block.get("tool_use_id") or "tool-call"),
            "name": str(block.get("name") or "unknown_tool"),
            "arguments": arguments if isinstance(arguments, (dict, list, str)) else {},
        }
    if block_type == "tool_result":
        result = {
            "type": "tool_result",
            "tool_call_id": str(block.get("tool_call_id") or block.get("tool_use_id") or ""),
            "content": block.get("content", ""),
        }
        if "is_error" in block:
            result["is_error"] = bool(block["is_error"])
        return result
    return None


def canonicalize_tool_messages(messages: Iterable[dict]) -> list[dict]:
    """提取工具往返并保存成与 provider 无关的历史消息。"""
    result: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        canonical: list[dict] = []
        if role == "assistant" and message.get("tool_calls"):
            if isinstance(content, str) and content:
                canonical.append({"type": "text", "text": content})
            for call in message["tool_calls"]:
                function = call.get("function") or {}
                normalized = _canonical_block({
                    "type": "tool_call", "id": call.get("id"),
                    "name": function.get("name"),
                    "arguments": function.get("arguments", "{}"),
                })
                if normalized is not None:
                    canonical.append(normalized)
        elif role == "tool":
            canonical.append({
                "type": "tool_result",
                "tool_call_id": str(message.get("tool_call_id") or ""),
                "content": content,
            })
        else:
            for block in _blocks(content):
                normalized = _canonical_block(block)
                if normalized is not None:
                    canonical.append(normalized)
                elif role == "assistant" and block.get("type") == "text" and block.get("text"):
                    canonical.append({"type": "text", "text": str(block["text"])})
        if canonical and any(block.get("type") in ("tool_call", "tool_result") for block in canonical):
            result.append({"role": role, "content": canonical})
    return result


def _anthropic_history_blocks(content_json) -> list[dict]:
    converted = []
    for block in _blocks(content_json):
        block_type = block.get("type")
        if block_type == "tool_call":
            converted.append({
                "type": "tool_use", "id": block.get("id"),
                "name": block.get("name"), "input": block.get("arguments", {}),
            })
        elif block_type == "tool_result":
            result = {
                "type": "tool_result",
                "tool_use_id": block.get("tool_call_id"),
                "content": block.get("content", ""),
            }
            if "is_error" in block:
                result["is_error"] = block["is_error"]
            converted.append(result)
        else:
            converted.append(block)
    return converted


def _openai_history_message(message, request) -> list[dict]:
    content_json = getattr(message, "content_json", None)
    if content_json is None:
        from agent.im.context_loader import format_history_content

        return [{"role": message.role, "content": format_history_content(message, request)}]

    from app.core.chat_attach import strip_vision_for_history
    content_json = strip_vision_for_history(content_json)
    blocks = _blocks(content_json)
    if not blocks:
        return [{"role": message.role, "content": content_text(content_json)}]

    text_parts: list[str] = []
    tool_calls: list[dict] = []
    tool_results: list[dict] = []
    for block in blocks:
        block_type = block.get("type")
        if block_type in ("tool_use", "tool_call"):
            tool_calls.append(_openai_tool_call(block))
        elif block_type == "tool_result":
            tool_results.append({
                "role": "tool",
                "tool_call_id": str(block.get("tool_call_id") or block.get("tool_use_id") or ""),
                "content": content_text(block.get("content", "")),
            })
        elif block_type == "text":
            if block.get("text"):
                text_parts.append(str(block["text"]))
        else:
            rendered = content_text(block)
            if rendered:
                text_parts.append(rendered)

    from agent.im.context_loader import format_attachment_refs
    attachment_refs = format_attachment_refs(message)
    if attachment_refs:
        text_parts.append(attachment_refs)

    result: list[dict] = []
    if message.role == "assistant" or tool_calls:
        assistant = {"role": "assistant", "content": "\n".join(text_parts) or None}
        if tool_calls:
            assistant["tool_calls"] = tool_calls
        result.append(assistant)
    elif text_parts:
        result.append({"role": message.role, "content": "\n".join(text_parts)})

    result.extend(tool_results)
    return result or [{"role": message.role, "content": content_text(content_json)}]


def build_history_parts(history: Iterable, request, *, use_anthropic: bool) -> list[dict]:
    """统一构建 history；一条持久化消息可能展开为多个 OpenAI tool 消息。"""
    parts: list[dict] = []
    for message in history:
        content_json = getattr(message, "content_json", None)
        if use_anthropic:
            if content_json is not None:
                from agent.im.context_loader import format_attachment_refs
                from app.core.chat_attach import strip_vision_for_history
                content_json = strip_vision_for_history(content_json)
                attachment_refs = format_attachment_refs(message)
                blocks = _blocks(content_json)
                if any(block.get("type") in ("tool_call", "tool_result") for block in blocks):
                    content = _anthropic_history_blocks(content_json)
                else:
                    content = list(content_json) if isinstance(content_json, list) else content_json
                if attachment_refs and isinstance(content, list):
                    content = [*content, {"type": "text", "text": attachment_refs}]
                role = "user" if message.role == "tool" else message.role
                parts.append({"role": role, "content": content})
            else:
                from agent.im.context_loader import format_history_content

                parts.append({"role": message.role, "content": format_history_content(message, request)})
        else:
            parts.extend(_openai_history_message(message, request))
    return parts
