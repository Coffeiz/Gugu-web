"""Canonical Context 组装入口。

Canonical Context 只负责语义分区和诊断元数据；实际消息统一由 ``assembly`` 包组装。
"""
from __future__ import annotations

from typing import Any, Iterable

from .canonical_context import CanonicalContext, group_history_units
from .assembly import PromptMessages, assemble


def build_context(*, fixed_parts: Iterable[dict], history: Iterable[dict],
                  current_batch: Iterable[dict] = (),
                  system_text: str | None = None) -> CanonicalContext:
    fixed = tuple(dict(item) for item in fixed_parts)
    history_values = tuple(dict(item) for item in history)
    current = tuple(dict(item) for item in current_batch)
    # 当前用户、RAG、姿态和时间都属于同一 current_turn；下一轮它们会正常进入
    # canonical_history，不再维护独立 dynamic tail。
    static = tuple(
        item for item in fixed
        if item.get("role") == "system"
        and not str(item.get("content", "")).startswith("[system-reminder]")
    )
    if system_text and not any(item.get("content") == system_text for item in static):
        static = ({"role": "system", "content": system_text},) + static
    static_ids = {id(item) for item in static}
    session = tuple(item for item in fixed if id(item) not in static_ids)
    return CanonicalContext(
        static_system=static,
        session_snapshot=session,
        canonical_history=history_values,
        current_turn=current,
        history_units=group_history_units(history_values),
    )


def build_messages(*, fixed_parts: Iterable[dict], history: Iterable[dict],
                   current_batch: Iterable[dict] = (),
                   system_text: str | None = None) -> PromptMessages:
    fixed = tuple(dict(item) for item in fixed_parts)
    history_values = tuple(dict(item) for item in history)
    conversation = assemble(
        fixed_parts=fixed,
        history=history_values,
    )
    batch = list(current_batch)
    conversation.append_batch(batch)
    conversation.canonical_context = build_context(
        fixed_parts=fixed,
        history=history_values,
        current_batch=batch,
        system_text=system_text,
    )
    return conversation
