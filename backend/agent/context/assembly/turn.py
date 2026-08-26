"""一轮用户请求的新增消息组装。"""
from __future__ import annotations

import hashlib
from typing import Iterable

from .batch import NewMessageBatch
from .system import reminder


def stance_digest(content: str | None) -> str:
    """返回姿态正文的稳定摘要；摘要只用于 session 状态，不进入消息正文。"""
    value = str(content or "").strip()
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16] if value else ""


def _time_context(message: dict) -> dict:
    """把时间 reminder 统一成可持久化、可稳定重放的 canonical block。"""
    return {
        "role": "user",
        "content": [{
            "type": "time-context",
            "text": str(message.get("content") or ""),
        }],
    }


def assemble_turn(*, stance: str | None = None,
                  previous_stance_digest: str | None = None,
                  message_time: dict | None = None,
                  current_user: dict | None = None,
                  conversation_tail: Iterable[dict] = (),
                  extra_reminder: str | None = None,
                  now_text: str | None = None) -> tuple[NewMessageBatch, str]:
    """把本轮新增内容一次性组装为 batch。

    姿态只有在摘要变化时才追加；历史中的旧姿态不会被删除或替换。
    """
    current_digest = stance_digest(stance)
    messages: list[dict] = []
    if stance and current_digest != (previous_stance_digest or ""):
        messages.append(reminder(stance))
    # 消息时间与姿态属于同一轮新增 batch。姿态在收尾时会作为 canonical event
    # 持久化到用户消息之前，因此这里也必须保持「姿态 -> 时间 -> 用户」的顺序，
    # 避免下一轮从 history 恢复后改变缓存前缀。
    if message_time:
        messages.append(_time_context(message_time))
    if current_user is not None:
        messages.append(current_user)
    messages.extend(dict(item) for item in conversation_tail)
    if extra_reminder:
        messages.append(reminder(extra_reminder))
    if now_text:
        messages.append(_time_context(reminder(f"当前时间：{now_text}")))
    return NewMessageBatch(messages), current_digest
