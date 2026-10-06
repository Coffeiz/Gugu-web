"""文件同步投影结果摘要；由实时路径投影与持久整树任务共用。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SyncSummary:
    scanned: int = 0
    created: int = 0
    updated: int = 0
    moved: int = 0
    deleted: int = 0
    rejected: int = 0
    conflicts: int = 0
    folders_created: int = 0
    folders_updated: int = 0
    folders_deleted: int = 0
    journal_ids: tuple[int, ...] = ()
    entity_ids: tuple[int, ...] = ()
    rejected_paths: tuple[str, ...] = ()
