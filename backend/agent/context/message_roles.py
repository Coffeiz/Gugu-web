"""会话消息角色判断，避免内部上下文被当成用户正文。"""
from __future__ import annotations

from typing import Any


_INTERNAL_BLOCK_TYPES = frozenset({
    "tool-schema",
    "skill-schema",
    "tool-discovery",
    "knowledge-context",
    "stance-context",
    "time-context",
    "runtime-context",
})


def _is_reminder_text(value: Any) -> bool:
    return isinstance(value, str) and value.lstrip().startswith("[system-reminder]")


def is_internal_user_message(message: Any) -> bool:
    """判断 user 消息是否仅由系统注入组成。"""
    if not isinstance(message, dict) or message.get("role") != "user":
        return False
    content = message.get("content")
    if _is_reminder_text(content):
        return True
    if not isinstance(content, list) or not content:
        return False
    for block in content:
        if not isinstance(block, dict):
            return False
        block_type = block.get("type")
        if block_type in _INTERNAL_BLOCK_TYPES:
            continue
        if block_type == "text" and _is_reminder_text(block.get("text")):
            continue
        return False
    return True


def last_user_index(messages: Any) -> int | None:
    """返回最后一条真实用户消息的位置，跳过内部 user reminder。"""
    if not isinstance(messages, list):
        return None
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, dict) and message.get("role") == "user":
            if not is_internal_user_message(message):
                return index
    return None


def user_text_from_message(message: Any) -> str:
    """提取真实用户文本，不把内部 block 复制到输入或 trace。"""
    if not isinstance(message, dict) or message.get("role") != "user":
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return "" if _is_reminder_text(content) else content
    if not isinstance(content, list):
        return ""
    bits: list[str] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = str(block.get("text") or "")
        if not _is_reminder_text(text):
            bits.append(text)
    return "\n".join(bits)
