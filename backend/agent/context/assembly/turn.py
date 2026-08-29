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
    """把时间 reminder 统一成可稳定重放的 canonical block。"""
    return {
        "role": "user",
        "content": [{
            "type": "time-context",
            "text": str(message.get("content") or ""),
        }],
    }


def _runtime_context(content: str) -> dict:
    """把只在当前 turn 生成、但后面可能跟随工具历史的运行上下文 canonical 化。"""
    wrapped = reminder(content)
    return {
        "role": "user",
        "content": [{
            "type": "runtime-context",
            "text": str(wrapped.get("content") or ""),
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
    Provider 投影与 canonical 投影在这里同时确定：用户消息时间由持久化
    ``sent_at`` 在下一 run 重建；runtime reminder / 当前日期若位于工具轨迹
    之前，则必须进入 canonical history，保证跨 run 能在原位置重放。
    """
    current_digest = stance_digest(stance)
    messages: list[dict] = []
    canonical_source: list[dict] = []
    if stance and current_digest != (previous_stance_digest or ""):
        messages.append(reminder(stance))
    # 姿态在收尾时会单独持久化到用户消息之前；message_time 由用户消息 sent_at
    # 重建，因此二者都不重复写入本 batch 的 canonical 投影。
    if message_time:
        messages.append(_time_context(message_time))
    if current_user is not None:
        messages.append(current_user)

    tail_messages = [dict(item) for item in conversation_tail]
    messages.extend(tail_messages)
    canonical_source.extend(tail_messages)

    if extra_reminder:
        # Provider 继续看到原来的普通 reminder 形状；canonical history 使用
        # runtime-context 保存同一段文本，下一 run 可无损恢复到同一位置。
        messages.append(reminder(extra_reminder))
        canonical_source.append(_runtime_context(extra_reminder))
    if now_text:
        now_message = _time_context(reminder(f"当前时间：{now_text}"))
        messages.append(now_message)

    # 当前用户正文已经在进入 LLM 前单独落库；这里只持久化 RAG/runtime/time
    # 等 provider-visible 附属上下文，避免下一 run 重新组装时改变前缀形状。
    from ..history import canonicalize_tool_messages

    canonical_messages = canonicalize_tool_messages(canonical_source)
    return NewMessageBatch.from_canonical_messages(
        canonical_messages,
        provider_messages=messages,
    ), current_digest
