"""记忆维护按完整条目和独立的文本体量上限分批。"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Callable, Sequence, TypeVar


T = TypeVar("T")

MAX_BATCH_CHARS = 24_000
MAX_EXISTING_MEMORY_CHARS = 12_000


@dataclass(frozen=True)
class MaintenanceContextBudget:
    """维护模型输入的统一预算契约。"""

    output_tokens: int
    batch_chars: int
    existing_memory_chars: int


def resolve_maintenance_budget(model_cfg) -> MaintenanceContextBudget:
    """按配置选择初始字符分档，实际请求能否容纳由 Provider 决定。"""
    config = getattr(model_cfg, "ai", model_cfg)
    context_tokens = int(getattr(config, "context_tokens", 0) or 0)
    output_tokens = int(getattr(config, "max_tokens", 0) or 0)
    if context_tokens <= 1 or output_tokens <= 0:
        raise ValueError("当前模型缺少有效的 context_tokens/max_tokens")
    # 小窗口先为固定提示词和新增内容留出空间，再选择独立的字符上限。
    output_tokens = min(output_tokens, max(1, context_tokens // 4))
    for window, batch, memory in (
        (4_096, 1_000, 400),
        (8_192, 2_500, 1_000),
        (16_384, 6_000, 2_000),
        (32_768, 12_000, 6_000),
    ):
        if context_tokens <= window:
            return MaintenanceContextBudget(output_tokens, batch, memory)
    return MaintenanceContextBudget(output_tokens, MAX_BATCH_CHARS, MAX_EXISTING_MEMORY_CHARS)


@dataclass(frozen=True)
class MaintenanceBatch:
    """一批完整条目及其预算元数据。"""

    items: tuple[T, ...]
    source_ids: tuple[str, ...]
    input_chars: int
    has_oversized_item: bool = False


def split_batches(
    items: Sequence[T],
    render: Callable[[T], str],
    source_id: Callable[[T], str],
    *,
    max_chars: int,
) -> list[MaintenanceBatch[T]]:
    """按完整条目切批，不拆分单条内容。

    单条超过 ``max_chars`` 时单独成批并标记 oversized；调用方应禁止该批
    自动 apply，而不是把原文静默截断后继续写回。
    """
    if max_chars <= 0:
        raise ValueError("maintenance batch budget must be positive")

    batches: list[MaintenanceBatch[T]] = []
    current: list[T] = []
    current_chars = 0

    def flush() -> None:
        nonlocal current, current_chars
        if current:
            batches.append(MaintenanceBatch(
                items=tuple(current),
                source_ids=tuple(str(source_id(item)) for item in current),
                input_chars=current_chars,
                has_oversized_item=False,
            ))
            current = []
            current_chars = 0

    for item in items:
        item_chars = len(render(item))
        if item_chars > max_chars:
            flush()
            batches.append(MaintenanceBatch(
                items=(item,),
                source_ids=(str(source_id(item)),),
                input_chars=item_chars,
                has_oversized_item=True,
            ))
            continue
        if current and current_chars + 1 + item_chars > max_chars:
            flush()
        current_chars += item_chars + bool(current)
        current.append(item)
    flush()
    return batches


def pattern_batches(patterns: Sequence[dict]) -> list[MaintenanceBatch[dict]]:
    """按 pattern 稳定 ID 切批，保留完整 pattern 条目。"""
    return split_batches(
        patterns,
        lambda item: f"({item.get('kind')}) {item.get('text', '')}",
        lambda item: str(item.get("id") or ""),
        max_chars=MAX_BATCH_CHARS,
    )


def message_batches(
    messages: Sequence[T], render: Callable[[T], str], source_id: Callable[[T], str],
    *, max_chars: int = MAX_BATCH_CHARS,
) -> list[MaintenanceBatch[T]]:
    """按完整 IM 消息切批，消息正文不会跨批拆分。"""
    return split_batches(
        messages,
        render,
        source_id,
        max_chars=max_chars,
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


def bounded_scope_memory(current: dict, *, max_chars: int = MAX_EXISTING_MEMORY_CHARS) -> str:
    """只为维护模型提供受限的已有记忆视图，不静默返回完整 scope JSON。"""
    parts: list[str] = []
    used = 0
    for key in ("summary", "profile", "pattern", "memory", "daily"):
        value = current.get(key) if isinstance(current, dict) else None
        if not value:
            continue
        text = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        label = f"{key}: "
        separator = bool(parts)
        remaining = max_chars - used - len(label) - separator
        if remaining <= 0:
            break
        text = text[:remaining].rstrip()
        if text:
            parts.append(label + text)
            used += len(parts[-1]) + separator
    return "\n".join(parts)
