"""唯一的 LLM 消息组装入口。"""
from __future__ import annotations

from typing import Iterable

from .batch import MessageBatch
from .area import (
    CanonicalAreaSnapshot, MessageArea, MessageEntry, MessageSource,
    PersistenceDelta, PersistencePolicy,
)
from .history import conversation_messages
from .snapshot import fixed_messages
from ..dynamic_tail import reminder_message as reminder
from .turn import assemble_turn, stance_digest


def assemble(*, fixed_parts: Iterable[dict], history: Iterable[dict],
             message_area: MessageArea | None = None,
             render_options: dict | None = None) -> MessageArea:
    fixed = fixed_messages(fixed_parts)
    history_values = list(history)
    conversation, fixed_prefix_size = conversation_messages(
        fixed_parts=fixed,
        history=history_values,
        current_user=None,
        conversation_tail=(),
    )
    area = message_area or MessageArea.from_restored(history_values)
    area.configure_request(
        fixed_prefix=conversation[:fixed_prefix_size],
        render_options=render_options,
    )
    return area


__all__ = [
    "CanonicalAreaSnapshot", "MessageArea", "MessageBatch", "MessageEntry",
    "MessageSource", "PersistenceDelta", "PersistencePolicy",
    "assemble", "assemble_turn", "fixed_messages", "reminder", "stance_digest",
]
