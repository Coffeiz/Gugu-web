"""上下文正文规范化与诊断估算工具。

本地估算只允许用于诊断、回归测试和 provider overflow 后的兼容旧接口，
不得用于正常历史组装、预算触发、压缩触发或重试决定。真实请求预算以
provider 返回的 usage/overflow 为准。
"""
from __future__ import annotations

import json

# 历史读取只保留非 token 的条数安全上限，预算由 provider 边界裁定。
HISTORY_MAX_MSGS = 500


def estimate_tokens(text: str) -> int:
    """CJK 感知的 token 估算。宁可略高估，避免超窗。"""
    if not text:
        return 0
    cjk = 0
    for ch in text:
        o = ord(ch)
        # CJK 统一表意 + 扩展A + 假名 + 全角标点
        if (0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
                or 0x3040 <= o <= 0x30FF or 0xFF00 <= o <= 0xFFEF):
            cjk += 1
    other = len(text) - cjk
    return int(cjk * 1.3 + other / 4) + 1


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


def msg_tokens(m) -> int:
    """一条 ConversationMessage 的估算 token——含 content_json（工具轮次正文在此，不在 content）。"""
    cj = getattr(m, "content_json", None)
    if cj is not None:
        return estimate_tokens(content_text(cj))
    return estimate_tokens(getattr(m, "content", "") or "")
