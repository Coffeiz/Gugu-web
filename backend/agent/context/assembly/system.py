"""system/reminder 消息片段。"""
from __future__ import annotations


def reminder(content: str) -> dict:
    """构造稳定边界明确的内部 reminder。"""
    return {"role": "user", "content": f"[system-reminder]\n{content}\n[/system-reminder]"}
