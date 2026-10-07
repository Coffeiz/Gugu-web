"""目录扫描结果与已发布基线之间的纯差异计划。"""
from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable, Iterator
from typing import Mapping

from app.services.filesync.scan import ScanEntry, ScanResult


@dataclass(frozen=True)
class ReconcilePlan:
    added: frozenset[str]
    changed: frozenset[str]
    missing: frozenset[str]
    unchanged: frozenset[str]
    complete: bool


@dataclass(frozen=True)
class ReconcileCandidate:
    operation: str
    relative_path: str
    current: ScanEntry | None
    previous: ScanEntry | None


def _ordered_items(
    entries: Mapping[str, ScanEntry], after: str | None = None,
) -> Iterator[tuple[str, ScanEntry]]:
    iterator = getattr(entries, "iter_sorted_after", None) if after is not None else None
    if iterator is not None:
        yield from iterator(after)
        return
    iterator = getattr(entries, "iter_sorted", None)
    if iterator is not None:
        for path, entry in iterator():
            if after is None or path > after:
                yield path, entry
        return
    for path, entry in sorted(entries.items()):
        if after is None or path > after:
            yield path, entry


def iter_reconcile_candidates(
    current: Mapping[str, ScanEntry],
    previous: Mapping[str, ScanEntry],
    *,
    complete: bool,
    start_after: str | None = None,
) -> Iterator[ReconcileCandidate]:
    """有序归并当前候选与成功基线；调用方无需把全量差异集合放进内存。"""
    current_items = iter(_ordered_items(current, start_after))
    previous_items = iter(_ordered_items(previous, start_after))
    current_item = next(current_items, None)
    previous_item = next(previous_items, None)
    excluded_roots: set[str] = set()

    def is_excluded(path: str) -> bool:
        parts = path.split("/")
        for index in range(1, len(parts) + 1):
            if "/".join(parts[:index]) in excluded_roots:
                return True
        return False

    # `start_after` is used by resumable conflict inspection. Seed only excluded
    # ancestors of the cursor; any later marker is encountered in merge order.
    if start_after:
        parts = start_after.split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            try:
                entry = current[prefix]
            except KeyError:
                continue
            if entry.object_type == "excluded":
                excluded_roots.add(prefix)

    while current_item is not None or previous_item is not None:
        if previous_item is None or (
            current_item is not None and current_item[0] < previous_item[0]
        ):
            path, entry = current_item
            if entry.object_type == "excluded":
                excluded_roots.add(path)
                yield ReconcileCandidate("excluded", path, entry, None)
                current_item = next(current_items, None)
                continue
            yield ReconcileCandidate("added", path, entry, None)
            current_item = next(current_items, None)
            continue
        if current_item is None or previous_item[0] < current_item[0]:
            path, entry = previous_item
            if is_excluded(path):
                yield ReconcileCandidate("protected", path, None, entry)
            elif complete:
                yield ReconcileCandidate("missing", path, None, entry)
            previous_item = next(previous_items, None)
            continue
        path, current_entry = current_item
        _, previous_entry = previous_item
        if current_entry.object_type == "excluded":
            excluded_roots.add(path)
            operation = "protected"
        else:
            operation = "unchanged" if current_entry == previous_entry else "changed"
        yield ReconcileCandidate(operation, path, current_entry, previous_entry)
        current_item = next(current_items, None)
        previous_item = next(previous_items, None)


def build_reconcile_plan(
    scan: ScanResult,
    previous: Mapping[str, ScanEntry],
) -> ReconcilePlan:
    """只将完整扫描中确实缺失的路径标为删除候选。"""
    added: set[str] = set()
    changed: set[str] = set()
    missing: set[str] = set()
    unchanged: set[str] = set()
    for candidate in iter_reconcile_candidates(
        scan.entries, previous, complete=scan.complete,
    ):
        if candidate.operation == "added":
            added.add(candidate.relative_path)
        elif candidate.operation == "changed":
            changed.add(candidate.relative_path)
        elif candidate.operation == "missing":
            missing.add(candidate.relative_path)
        elif candidate.operation == "unchanged":
            unchanged.add(candidate.relative_path)
    return ReconcilePlan(
        frozenset(added), frozenset(changed), frozenset(missing),
        frozenset(unchanged), scan.complete,
    )


def iter_success_baseline_entries(
    current: Mapping[str, ScanEntry],
    previous: Mapping[str, ScanEntry],
    *,
    preserve_missing: bool,
    is_blocked: Callable[[str], bool] | None = None,
) -> Iterator[tuple[str, ScanEntry]]:
    """生成下一基线的有序流；删除同步关闭时保留尚未删除的旧条目。"""
    for candidate in iter_reconcile_candidates(current, previous, complete=True):
        if candidate.operation == "protected":
            if candidate.previous is not None:
                yield candidate.relative_path, candidate.previous
        elif candidate.operation == "excluded":
            if candidate.current is not None:
                yield candidate.relative_path, candidate.current
        elif is_blocked is not None and is_blocked(candidate.relative_path):
            if candidate.previous is not None:
                yield candidate.relative_path, candidate.previous
        elif candidate.current is not None:
            yield candidate.relative_path, candidate.current
        elif preserve_missing and candidate.previous is not None:
            yield candidate.relative_path, candidate.previous
