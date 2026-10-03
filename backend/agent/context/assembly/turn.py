"""一轮用户请求的新增消息组装。"""
from __future__ import annotations

import hashlib
from typing import Iterable

from .batch import MessageBatch
from .area import MessageSource, PersistencePolicy
from ..canonical_context import MEDIA_BLOCK_TYPES
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


def assemble_turn(*, stance: str | None = None,
                  previous_stance_digest: str | None = None,
                  message_time: dict | None = None,
                  current_user: dict | None = None,
                  conversation_tail: Iterable[dict] = (),
                  extra_reminder: str | None = None) -> tuple[MessageBatch, str]:
    """把本轮新增内容一次性组装为 batch。

    姿态只有在摘要变化时才追加；历史中的旧姿态不会被删除或替换。
    当前轮所有消息都按顺序进入 Batch/Area；entry policy 分别控制持久化、请求结束
    丢弃或恢复时重建。当前轮消息时间由 ``sent_at`` 生成，持久化策略为重建；实时
    当前时间由 ``get_current_time`` 按需获取，不进入历史。
    """
    current_digest = stance_digest(stance)
    messages: list[dict] = []
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
    # 姿态和 RAG 在收尾时按各自策略持久化到用户消息之前；当前时间与当前用户
    # 也留在同一有序 Area 中，但分别采用“恢复时重建”及“已提前持久化”策略。
    # RAG 必须位于当前用户问题之前；下一轮 history 会按同样的
    # canonical 顺序恢复。当前时间不持久化，因此放在 RAG 后、用户正文前；下次
    # 恢复时从用户时间戳重建，不会把本轮时间重复写入历史。
    tail_messages = [dict(item) for item in conversation_tail]
    messages.extend(tail_messages)

    if message_time:
        messages.append(_time_context(message_time))
    if current_user is not None:
        messages.append(current_user)

    # Batch 只持有完整 canonical entries 一份；持久化选择由每条 entry 的策略决定。
    batch = MessageBatch.from_area_entries(_build_area_entries(
        messages=messages,
        previous_stance_digest=previous_stance_digest,
        current_digest=current_digest,
        stance=stance,
        tail_messages=tail_messages,
        message_time=message_time,
        current_user=current_user,
    ), metadata={"dynamic_tail": [reminder(extra_reminder)]} if extra_reminder else None)
    return batch, current_digest


def _build_area_entries(
    *, messages, previous_stance_digest, current_digest, stance, tail_messages,
    message_time, current_user,
) -> list[dict]:
    """为同一 turn 的 entries 标注来源与 durability，不改变 Provider 顺序。"""
    from ..history import canonicalize_tool_messages

    entries: list[dict] = []
    if stance and current_digest != (previous_stance_digest or ""):
        stance_message = next(
            message for message in messages
            if any(
                isinstance(block, dict) and block.get("type") == "stance-context"
                for block in (message.get("content") or [])
            )
        )
        entries.append({
            "message": canonicalize_tool_messages([stance_message])[0],
            "source": MessageSource.STANCE.value,
            "persistence_policy": PersistencePolicy.COMMIT_ON_SUCCESS.value,
        })
    entries.extend({
        "message": _canonical_snapshot(item, canonicalize_tool_messages),
        "source": MessageSource.RAG.value,
        "persistence_policy": PersistencePolicy.COMMIT_ON_SUCCESS.value,
    } for item in tail_messages)
    if message_time:
        entries.append({
            "message": _time_context(message_time),
            "source": MessageSource.MESSAGE_TIME.value,
            "persistence_policy": PersistencePolicy.RECONSTRUCT_ON_RESTORE.value,
        })
    if current_user is not None:
        entries.append({
            "area_key": "current_user",
            "message": _canonical_snapshot(current_user, canonicalize_tool_messages),
            "source": _current_user_source(current_user).value,
            "persistence_policy": PersistencePolicy.ALREADY_PERSISTED.value,
        })
    return entries


def _canonical_snapshot(message: dict, canonicalize_tool_messages) -> dict:
    converted = canonicalize_tool_messages([message])
    return converted[0] if converted else dict(message)


def _current_user_source(message: dict) -> MessageSource:
    content = message.get("content")
    blocks = content if isinstance(content, list) else []
    if any(
        isinstance(block, dict)
        and block.get("type") == "knowledge-context"
        and block.get("scope") == "explicit-reference"
        for block in blocks
    ):
        return MessageSource.REFERENCE
    if any(
        isinstance(block, dict)
        and block.get("type") in MEDIA_BLOCK_TYPES
        for block in blocks
    ):
        return MessageSource.ATTACHMENT
    return MessageSource.USER
