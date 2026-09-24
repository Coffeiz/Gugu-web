"""一轮用户请求的新增消息组装。"""
from __future__ import annotations

import hashlib
from typing import Iterable

from .batch import NewMessageBatch
from ..dynamic_tail import reminder_message as reminder


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
                  extra_reminder: str | None = None) -> tuple[NewMessageBatch, str]:
    """把本轮新增内容一次性组装为 batch。

    姿态只有在摘要变化时才追加；历史中的旧姿态不会被删除或替换。
    当前轮消息时间由当前用户消息的 ``sent_at`` 生成，放在正文前并只进入 provider
    投影，不写入 canonical history；实时当前时间由 ``get_current_time`` 按需获取。
    runtime reminder 进入 canonical history，保证跨 run 能在原位置重放。
    """
    current_digest = stance_digest(stance)
    messages: list[dict] = []
    canonical_source: list[dict] = []
    if stance and current_digest != (previous_stance_digest or ""):
        wrapped_stance = reminder(stance)
        messages.append({
            "role": "user",
            "content": [{
                "type": "stance-context",
                "digest": current_digest,
                "text": str(wrapped_stance.get("content") or ""),
            }],
        })
    # 姿态在收尾时会单独持久化到用户消息之前；当前时间和用户消息都不重复写入
    # 本 batch 的 canonical 投影，下一 run 由 sent_at 重新构造历史“消息时间”。
    # RAG 必须位于当前用户问题之前；下一轮 history 会按同样的
    # canonical 顺序恢复。当前时间不持久化，因此放在 RAG 后、用户正文前；下次
    # 恢复时会用历史消息时间代替，不会把当前时间重复写进上下文。
    tail_messages = [dict(item) for item in conversation_tail]
    messages.extend(tail_messages)
    canonical_source.extend(tail_messages)

    if message_time:
        messages.append(_time_context(message_time))
    if current_user is not None:
        messages.append(current_user)

    if extra_reminder:
        # Provider 继续看到原来的普通 reminder 形状；canonical history 使用
        # runtime-context 保存同一段文本，下一 run 可无损恢复到同一位置。
        messages.append(reminder(extra_reminder))
        canonical_source.append(_runtime_context(extra_reminder))
    # 当前用户正文已经在进入 LLM 前单独落库；这里只持久化 RAG/runtime
    # 等必须跨 run 保持原位置的附属上下文。
    from ..history import canonicalize_tool_messages

    canonical_messages = canonicalize_tool_messages(canonical_source)
    return NewMessageBatch.from_canonical_messages(
        canonical_messages,
        provider_messages=messages,
    ), current_digest
