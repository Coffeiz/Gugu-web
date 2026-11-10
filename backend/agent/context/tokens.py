"""规范化上下文中的文本与消息结构。"""
from __future__ import annotations

import json

def _json_content(value) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def content_text(content) -> str:
    """把字符串或 provider content blocks 规范成可估算、可摘要的文本。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (int, float, bool)):
        return str(content)
    if isinstance(content, list):
        return "\n".join(part for part in (content_text(item) for item in content) if part)
    if isinstance(content, dict):
        block_type = content.get("type")
        if block_type in {"image", "image_url", "input_image"}:
            return "[图片]"
        if block_type in {"input_audio", "audio", "video_url"}:
            return "[媒体]"
        if block_type == "text":
            return str(content.get("text") or "")
        if block_type in {"reasoning", "reasoning_content"}:
            value = content.get("text", content.get("content", ""))
            return f"[思考]\n{content_text(value)}" if value else ""
        if block_type in {"tool_use", "tool_call"}:
            name = content.get("name") or "未知工具"
            arguments = content.get("input", content.get("arguments", {}))
            return f"[工具调用:{name}]\n{_json_content(arguments)}"
        if block_type == "tool_result":
            tool_id = content.get("tool_use_id") or content.get("tool_call_id") or ""
            prefix = f"[工具结果:{tool_id}]" if tool_id else "[工具结果]"
            return f"{prefix}\n{content_text(content.get('content', ''))}"
        return _json_content({k: v for k, v in content.items() if k != "cache_control"})
    return str(content)


def message_text(message: dict) -> str:
    """规范一条 provider 消息，包含 OpenAI 独立字段里的工具调用。"""
    parts = [content_text(message.get("content", ""))]
    for key in ("tool_calls", "reasoning_content"):
        value = message.get(key)
        if value:
            parts.append(f"[{key}]\n{content_text(value)}")
    return "\n".join(part for part in parts if part)
