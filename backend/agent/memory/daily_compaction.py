"""各类记忆作用域共用的 daily 全量沉淀批次规则。"""
from __future__ import annotations

from typing import Sequence, TypeVar

T = TypeVar("T")

# 每次只交给维护模型一个固定批次，避免存量异常时把整份 daily 一次性送入。
COMPACTION_BATCH_SIZE = 100


def should_compact(count: int, *, trigger: int) -> bool:
    """达到触发条数后启动，把当时积累的 daily 全部沉淀。"""
    return count >= trigger


def split_oldest_batch(
    entries: Sequence[T], *, batch_size: int = COMPACTION_BATCH_SIZE,
) -> tuple[list[T], list[T]]:
    """返回（仍待处理的较新记录、当前最旧批次）。输入顺序为新到旧。"""
    items = list(entries)
    size = max(1, batch_size)
    if len(items) <= size:
        return [], items
    return items[:-size], items[-size:]
