"""唯一的 LLM 消息组装入口。"""
from __future__ import annotations

from typing import Iterable

from .batch import NewMessageBatch
from .history import conversation_messages
from .messages import PromptMessages, newly_appended
from .snapshot import fixed_messages
from .system import reminder
from .turn import assemble_turn, stance_digest


def assemble(*, fixed_parts: Iterable[dict], history: Iterable[dict],
             system_text: str | None = None,
             include_system: bool = False) -> PromptMessages:
    fixed = fixed_messages(
        fixed_parts, system_text=system_text, include_system=include_system,
    )
    conversation, fixed_prefix_size = conversation_messages(
        fixed_parts=fixed,
        history=history,
        current_user=None,
        conversation_tail=(),
    )
    return PromptMessages(conversation, fixed_prefix_size=fixed_prefix_size)


__all__ = [
    "NewMessageBatch", "PromptMessages", "assemble", "assemble_turn",
    "fixed_messages", "newly_appended", "reminder", "stance_digest",
]
