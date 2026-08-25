"""Canonical Context 组装入口。

当前阶段复用已经稳定运行的 ``message_assembly``，只增加语义分区和诊断元数据。
这样 Web、IM、scheduled 可以先统一入口，再逐步迁移业务组装细节。
"""
from __future__ import annotations

from typing import Any, Iterable

from .canonical_context import CanonicalContext, group_history_units
from .message_assembly import PromptMessages
from . import message_assembly


def build_context(*, fixed_parts: Iterable[dict], history: Iterable[dict],
                  current_user: dict | None, dynamic_tail: Iterable[dict],
                  conversation_tail: Iterable[dict] = (),
                  system_text: str | None = None) -> CanonicalContext:
    fixed = tuple(dict(item) for item in fixed_parts)
    history_values = tuple(dict(item) for item in history)
    current = (dict(current_user),) if current_user is not None else ()
    tail = tuple(dict(item) for item in conversation_tail)
    # 当前用户消息和本轮持久化 RAG 属于同一 current_turn，避免把 RAG
    # 误认为动态尾部；下一轮它们会正常进入 canonical_history。
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
        current_turn=current + tail,
        dynamic_tail=tuple(dict(item) for item in dynamic_tail),
        history_units=group_history_units(history_values),
    )


def build_messages(*, fixed_parts: Iterable[dict], history: Iterable[dict],
                   current_user: dict | None, dynamic_tail: Iterable[dict],
                   conversation_tail: Iterable[dict] = (),
                   system_text: str | None = None) -> PromptMessages:
    fixed = tuple(dict(item) for item in fixed_parts)
    history_values = tuple(dict(item) for item in history)
    current = dict(current_user) if current_user is not None else None
    dynamic = tuple(dict(item) for item in dynamic_tail)
    conversation = message_assembly.build_messages(
        fixed_parts=fixed,
        history=history_values,
        current_user=current,
        dynamic_tail=dynamic,
        conversation_tail=conversation_tail,
    )
    conversation.canonical_context = build_context(
        fixed_parts=fixed,
        history=history_values,
        current_user=current,
        dynamic_tail=dynamic,
        conversation_tail=conversation_tail,
        system_text=system_text,
    )
    return conversation


def reminder(content: str) -> dict:
    return message_assembly.reminder(content)


# 新入口名称；build_messages 保留为迁移期间的兼容 API。
assemble = build_messages


def newly_appended(messages: list, initial_conversation_len: int) -> list[dict]:
    return message_assembly.newly_appended(messages, initial_conversation_len)
