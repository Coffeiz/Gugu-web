"""历史与本轮持久化消息片段。"""
from __future__ import annotations

from typing import Iterable


def conversation_messages(*, fixed_parts: Iterable[dict], history: Iterable[dict],
                          current_user: dict | None,
                          conversation_tail: Iterable[dict]) -> tuple[list[dict], int]:
    fixed = list(fixed_parts)
    conversation = fixed + list(history)
    if current_user is not None:
        conversation.append(current_user)
    conversation.extend(conversation_tail)
    return conversation, len(fixed)
