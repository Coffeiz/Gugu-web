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
    arguments = block.get("input", {})
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


def _openai_history_message(message, request) -> list[dict]:
    content_json = getattr(message, "content_json", None)
    if content_json is None:
        from agent.im.context_loader import format_history_content

        return [{"role": message.role, "content": format_history_content(message, request)}]

    blocks = _blocks(content_json)
    if not blocks:
        return [{"role": message.role, "content": content_text(content_json)}]

    text_parts: list[str] = []
    tool_calls: list[dict] = []
    tool_results: list[dict] = []
    for block in blocks:
        block_type = block.get("type")
        if block_type == "tool_use":
            tool_calls.append(_openai_tool_call(block))
        elif block_type == "tool_result":
            tool_results.append({
                "role": "tool",
                "tool_call_id": str(block.get("tool_use_id") or ""),
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
                attachment_refs = format_attachment_refs(message)
                content = list(content_json) if isinstance(content_json, list) else content_json
                if attachment_refs and isinstance(content, list):
                    content = [*content, {"type": "text", "text": attachment_refs}]
                parts.append({"role": message.role, "content": content})
            else:
                from agent.im.context_loader import format_history_content

                parts.append({"role": message.role, "content": format_history_content(message, request)})
        else:
            parts.extend(_openai_history_message(message, request))
    return parts
