"""各类记忆作用域共用的 daily 批量压缩编排。"""
from __future__ import annotations

from typing import Sequence, TypeVar

T = TypeVar("T")

# 每次只交给维护模型一个固定批次，避免存量异常时把整份 daily 一次性送入。
COMPACTION_BATCH_SIZE = 100


def should_compact(count: int, *, trigger: int, keep_recent: int,
                   batch_size: int = COMPACTION_BATCH_SIZE) -> bool:
    """初次达到阈值或已有积压时继续压缩；低于保留窗口则停止。"""
    return count >= trigger or count >= keep_recent + batch_size


def split_batch(entries: Sequence[T], *, keep_recent: int,
                batch_size: int = COMPACTION_BATCH_SIZE) -> tuple[list[T], list[T], list[T]]:
    """返回（保留的最新记录、当前压缩批次、尚未处理的旧记录）。"""
    items = list(entries)
    start = max(0, keep_recent)
    return items[:start], items[start:start + batch_size], items[start + batch_size:]


def merge_remaining(recent: Sequence[T], remaining: Sequence[T]) -> list[T]:
    """压缩成功后合并，保留未处理的旧记录，顺序仍是新到旧。"""
    return list(recent) + list(remaining)
