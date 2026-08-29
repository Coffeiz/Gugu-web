"""IM mention 的平台无关归一化。"""
from __future__ import annotations

import re


# 平台网关已经确认 mention 指向当前机器人后，才允许移除首个 mention。
# 未确认目标时不做猜测，避免误删用户正文里的 @某人。
_LEADING_MENTION = re.compile(r"^\s*(?:<@!?[^>\s]+>|[@＠][^\s/／]+)\s*")


def normalize_semantic_text(text: str | None, *, bot_mentioned: bool = False) -> str:
    """生成供命令、交互和取消判定使用的文本。

    原始文本仍保留在消息与上下文中；这里只在网关明确确认当前 bot 被 @ 时，
    移除开头的一个 mention。若平台已经在 SDK 层剥离 mention，则文本保持不变。
    """
    value = str(text or "").strip()
    if not bot_mentioned:
        return value
    return _LEADING_MENTION.sub("", value, count=1).strip()


def payload_semantic_text(payload: dict, text: str | None = None) -> str:
    """按统一 mention 标记取得消息的语义文本。"""
    return normalize_semantic_text(
        payload.get("text") if text is None else text,
        bot_mentioned=bool(payload.get("bot_mentioned", payload.get("group_mentioned"))),
    )


__all__ = ["normalize_semantic_text", "payload_semantic_text"]
