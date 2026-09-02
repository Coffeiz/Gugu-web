"""记忆维护模型的输入预算和稳定分批原语。

这里不负责权限、持久化或模型调用，只保证维护入口不会把无限增长的条目列表
直接拼成一个 prompt。默认使用保守的字符估算；未来接入模型 tokenizer 时，
只替换 estimate_tokens，不改变调用方的批次契约。
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from math import ceil
from typing import Callable, Sequence, TypeVar


T = TypeVar("T")

MAINTENANCE_MAX_INPUT_TOKENS = 6000
MAINTENANCE_MAX_ITEM_TOKENS = 3500
CHARS_PER_ESTIMATED_TOKEN = 4


@dataclass(frozen=True)
class MaintenanceContextBudget:
    """维护模型输入的统一预算契约。"""

    max_input_tokens: int = MAINTENANCE_MAX_INPUT_TOKENS
    max_item_tokens: int = MAINTENANCE_MAX_ITEM_TOKENS


def estimate_tokens(text: str) -> int:
    """返回保守的输入 token 估算；中英文混合内容按 4 字符/token 估算。"""
    text = str(text or "")
    return max(1, ceil(len(text) / CHARS_PER_ESTIMATED_TOKEN)) if text else 0


@dataclass(frozen=True)
class MaintenanceBatch:
    """一批完整条目及其预算元数据。"""

    items: tuple[T, ...]
    source_ids: tuple[str, ...]
    estimated_input_tokens: int
    has_oversized_item: bool = False


def split_batches(
    items: Sequence[T],
    render: Callable[[T], str],
    source_id: Callable[[T], str],
    *,
    max_tokens: int = MAINTENANCE_MAX_INPUT_TOKENS,
    max_item_tokens: int = MAINTENANCE_MAX_ITEM_TOKENS,
) -> list[MaintenanceBatch[T]]:
    """按完整条目切批，不拆分单条内容。

    单条超过 ``max_item_tokens`` 时单独成批并标记 oversized；调用方应禁止该批
    自动 apply，而不是把原文静默截断后继续写回。
    """
    if max_tokens <= 0 or max_item_tokens <= 0:
        raise ValueError("maintenance batch budget must be positive")

    batches: list[MaintenanceBatch[T]] = []
    current: list[T] = []
    current_tokens = 0

    def flush() -> None:
        nonlocal current, current_tokens
        if current:
            batches.append(MaintenanceBatch(
                items=tuple(current),
                source_ids=tuple(str(source_id(item)) for item in current),
                estimated_input_tokens=current_tokens,
                has_oversized_item=False,
            ))
            current = []
            current_tokens = 0

    for item in items:
        item_tokens = estimate_tokens(render(item))
        if item_tokens > max_item_tokens:
            flush()
            batches.append(MaintenanceBatch(
                items=(item,),
                source_ids=(str(source_id(item)),),
                estimated_input_tokens=item_tokens,
                has_oversized_item=True,
            ))
            continue
        if current and current_tokens + item_tokens > max_tokens:
            flush()
        current.append(item)
        current_tokens += item_tokens
    flush()
    return batches


def pattern_batches(patterns: Sequence[dict], *, max_tokens: int = MAINTENANCE_MAX_INPUT_TOKENS) -> list[MaintenanceBatch[dict]]:
    """按 pattern 稳定 ID 切批，保留完整 pattern 条目。"""
    return split_batches(
        patterns,
        lambda item: f"({item.get('kind')}) {item.get('text', '')}",
        lambda item: str(item.get("id") or ""),
        max_tokens=max_tokens,
    )


def message_batches(messages: Sequence[T], render: Callable[[T], str], source_id: Callable[[T], str], *, max_tokens: int = 4500) -> list[MaintenanceBatch[T]]:
    """按完整 IM 消息切批，消息正文不会跨批拆分。"""
    return split_batches(
        messages,
        render,
        source_id,
        max_tokens=max_tokens,
        max_item_tokens=MAINTENANCE_MAX_ITEM_TOKENS,
    )


def scope_revision(current: object, source_ids: Sequence[object], source_text: str) -> str:
    """为预览输入生成稳定 revision；不把原文写入 revision 或日志。"""
    payload = json.dumps(
        {"current": current, "source_ids": [str(value) for value in source_ids], "source_text": source_text},
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def bounded_scope_memory(current: dict, *, max_tokens: int = 2500) -> str:
    """只为维护模型提供受限的已有记忆视图，不静默返回完整 scope JSON。"""
    budget = max_tokens * CHARS_PER_ESTIMATED_TOKEN
    parts: list[str] = []
    used = 0
    for key in ("summary", "profile", "pattern", "memory", "daily"):
        value = current.get(key) if isinstance(current, dict) else None
        if not value:
            continue
        text = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        remaining = budget - used
        if remaining <= 0:
            break
        text = text[:remaining].rstrip()
        if text:
            parts.append(f"{key}: {text}")
            used += len(text)
    return "\n".join(parts)
