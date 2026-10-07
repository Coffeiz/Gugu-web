"""本地目录扫描结果的冲突处理、批次投影与成功基线发布。"""
from __future__ import annotations

import asyncio
import time
import threading
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable, Iterable, Mapping

from sqlalchemy import func, select

from app.core.tz import now_utc
from app.models import (
    File, FileSyncBinding, FileSyncConflict,
    FileSyncReconcileRun, FileSyncUserScanState,
)
from app.services.filesync.job_errors import ProjectionSliceExpired
from app.services.filesync.job_spec import ReconcileJobSpec
from app.services.filesync.job_lifecycle import publish_scan_success, record_run_progress
from app.services.filesync.health import clear_reconcile_gap_if_current
from app.services.filesync.checkpoint import ScanCandidateEntries, ScanCheckpointStore
from app.services.filesync.plan import (
    iter_reconcile_candidates, iter_success_baseline_entries,
)
from app.services.filesync.protocol import FileSyncMode, FileSyncSource
from app.services.filesync.scan import ScanEntry, ScanResult
from app.services.filesync.targeted import PathEventBatch, project_path_events


@dataclass(slots=True)
class ScanProjectionExecution:
    """一次本地扫描投影的固定输入与可恢复状态。"""

    session_factory: Callable
    spec: ReconcileJobSpec
    scan: ScanResult
    previous: Mapping[str, ScanEntry]
    stop: threading.Event
    deadline: float
    slice_deadline: float
    slice_started: float
    checkpoint_store: ScanCheckpointStore
    checkpoint_state: dict


@dataclass(frozen=True, slots=True)
class ScanProjectionRuntime:
    """投影执行所需的协作边界，和任务输入分离。"""

    check_active: Callable
    setting: Callable
    batch_size: int


@dataclass(frozen=True, slots=True)
class ConflictScanRuntime:
    check_active: Callable
    batch_size: int


def _batches(values: Iterable[str], size: int):
    batch = []
    for value in values:
        batch.append(value)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def projection_phases(allow_delete: bool):
    phases = [
        ("folders_created", {"added", "changed"}, "folder"),
        ("changed", {"added", "changed"}, "file"),
    ]
    if allow_delete:
        phases.extend((
            ("deleted", {"missing"}, "file"),
            ("folders_deleted", {"missing"}, "folder"),
        ))
    return phases


def _matching_paths(scan: ScanResult, previous: Mapping[str, ScanEntry], operations, object_type):
    for candidate in iter_reconcile_candidates(
        scan.entries, previous, complete=scan.complete,
    ):
        entry = candidate.current or candidate.previous
        if candidate.operation in operations and entry is not None and entry.object_type == object_type:
            yield candidate.relative_path


def projection_batches(
    scan: ScanResult,
    previous: Mapping[str, ScanEntry],
    allow_delete: bool,
    *,
    is_blocked=None,
    batch_size: int,
):
    for group_name, operations, object_type in projection_phases(allow_delete):
        candidates = _matching_paths(scan, previous, operations, object_type)
        if is_blocked is not None:
            candidates = (path for path in candidates if not is_blocked(path))
        for paths in _batches(candidates, batch_size):
            yield group_name, paths


def _may_be_reused_as_move_source(
    entry: ScanEntry,
    current_entries: Mapping[str, ScanEntry],
    previous: Mapping[str, ScanEntry],
) -> bool:
    if entry.fingerprint is None:
        return False
    if isinstance(current_entries, ScanCandidateEntries):
        return current_entries.has_added_file_signature(entry.size_bytes, entry.fingerprint)
    return any(
        item.object_type == "file"
        and item.size_bytes == entry.size_bytes
        and item.fingerprint == entry.fingerprint
        for path, item in current_entries.items()
        if path not in previous
    )


async def _reclaimable_missing_file_bytes(
    session_factory,
    spec: ReconcileJobSpec,
    scan: ScanResult,
    previous: Mapping[str, ScanEntry],
    *,
    is_blocked: Callable[[str], bool],
) -> int:
    """为本轮新文件预留确定会删除的旧文件容量，排除可识别的移动源。"""
    if not spec["allow_delete"] or not scan.complete:
        return 0
    if isinstance(scan.entries, ScanCandidateEntries):
        scan.entries.prepare_added_file_signatures(previous)

    def reclaimable_paths():
        for candidate in iter_reconcile_candidates(scan.entries, previous, complete=True):
            entry = candidate.previous
            if (
                candidate.operation != "missing" or entry is None
                or entry.object_type != "file" or is_blocked(candidate.relative_path)
            ):
                continue
            # 相同内容可能是本轮新增文件复用原 File 身份的 move。宁可少预留容量，
            # 也不能把仍会被复用的源行同时计作可删除空间。
            if _may_be_reused_as_move_source(entry, scan.entries, previous):
                continue
            yield candidate.relative_path

    scope = spec["root"].relative_to(spec["user_root"]).as_posix().rstrip("/")
    storage_prefix = f"{spec['user_id']}/" if scope in {"", "."} else f"{spec['user_id']}/{scope}/"
    total = 0
    async with session_factory() as db:
        for paths in _batches(reclaimable_paths(), 200):
            storage_keys = [storage_prefix + path for path in paths]
            total += int(await db.scalar(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
                File.user_id == spec["user_id"],
                File.deleted_at.is_(None),
                File.storage_key.in_(storage_keys),
            )) or 0)
    return total

def candidate_batches_after(
    scan: ScanResult,
    previous: Mapping[str, ScanEntry],
    *,
    cursor: str | None,
    batch_size: int,
):
    candidates = iter_reconcile_candidates(
        scan.entries, previous, complete=scan.complete, start_after=cursor,
    )
    for batch in _batches(
        (
            item.relative_path for item in candidates
            if item.operation not in {"protected", "excluded"}
            and not (item.current is not None and item.current.object_type == "excluded")
        ),
        batch_size,
    ):
        yield batch


async def prepare_conflict_blocks(
    execution: ScanProjectionExecution,
    runtime: ConflictScanRuntime,
) -> None:
    """分批发现并持久化冲突阻塞，避免整树任务绕过既有冲突契约。"""
    from app.services.filesync.conflicts import inspect_conflict_batch

    session_factory = execution.session_factory
    spec = execution.spec
    scan = execution.scan
    previous = execution.previous
    stop = execution.stop
    deadline = execution.deadline
    slice_deadline = execution.slice_deadline
    checkpoint_store = execution.checkpoint_store
    checkpoint_state = execution.checkpoint_state
    check_active = runtime.check_active
    batch_size = runtime.batch_size

    if checkpoint_state.get("conflict_scan_complete"):
        return
    if spec["binding_mode"] != "bidirectional" and not checkpoint_state.get(
        "has_pending_conflicts_checked",
    ):
        async with session_factory() as db:
            pending_count = await db.scalar(select(func.count()).select_from(
                FileSyncConflict,
            ).where(
                FileSyncConflict.binding_id == spec["binding_id"],
                FileSyncConflict.status == "pending",
            ))
        checkpoint_state["has_pending_conflicts_checked"] = True
        if not pending_count:
            checkpoint_state["conflict_scan_complete"] = True
            checkpoint_store.save_state(checkpoint_state)
            return
    cursor = checkpoint_state.get("conflict_scan_cursor")
    for candidate_paths in candidate_batches_after(
        scan, previous, cursor=cursor, batch_size=batch_size,
    ):
        if time.monotonic() >= slice_deadline:
            raise ProjectionSliceExpired
        if not await check_active(
            session_factory, spec["run_id"], spec["token"], stop, deadline,
            binding_id=spec["binding_id"],
            binding_revision=spec["binding_revision"],
        ):
            raise TimeoutError("cancelled_or_timed_out")
        entries = {
            path: scan.entries[path]
            for path in candidate_paths
            if path in scan.entries and scan.entries[path].object_type == "file"
        }
        async with session_factory() as db:
            binding = await db.get(FileSyncBinding, spec["binding_id"])
            if binding is None:
                raise RuntimeError("binding_unavailable")
            blocked_paths = await inspect_conflict_batch(
                db,
                user_id=spec["user_id"],
                binding=binding,
                root=spec["root"],
                user_root=spec["user_root"],
                other_roots=spec["other_roots"],
                candidate_paths=candidate_paths,
                entries=entries,
                persist=not spec["dry_run"],
            )
            await db.commit()
        checkpoint_store.block_paths(blocked_paths)
        cursor = candidate_paths[-1]
        checkpoint_state["conflict_scan_cursor"] = cursor
        checkpoint_state["conflict_count"] = checkpoint_store.blocked_count()
        checkpoint_store.save_state(checkpoint_state)
        if time.monotonic() >= slice_deadline:
            raise ProjectionSliceExpired

    checkpoint_state["conflict_scan_complete"] = True
    checkpoint_state["conflict_count"] = checkpoint_store.blocked_count()
    checkpoint_store.save_state(checkpoint_state)


async def apply_scan_projection(
    execution: ScanProjectionExecution,
    runtime: ScanProjectionRuntime,
) -> dict:
    from app.services.filesync.outbox import deliver_file_event, enqueue_file_event
    from app.services.filesync.conflicts import inspect_conflict_batch

    from app.services.filesync.baseline import FileSyncBaselineStore

    session_factory = execution.session_factory
    spec = execution.spec
    scan = execution.scan
    previous = execution.previous
    stop = execution.stop
    deadline = execution.deadline
    slice_deadline = execution.slice_deadline
    slice_started = execution.slice_started
    checkpoint_store = execution.checkpoint_store
    checkpoint_state = execution.checkpoint_state
    check_active = runtime.check_active
    setting = runtime.setting
    batch_size = runtime.batch_size

    run_id, token = spec["run_id"], spec["token"]
    counts = dict(checkpoint_state.get("projection_counts") or {
        "scanned": len(scan.entries), "hashed": scan.hashed_count,
        "reused": scan.file_count - scan.hashed_count, "created": 0,
        "updated": 0, "moved": 0, "deleted": 0, "rejected": 0,
        "excluded": scan.excluded_count, "conflicts": 0,
    })
    await prepare_conflict_blocks(
        execution,
        ConflictScanRuntime(check_active=check_active, batch_size=batch_size),
    )
    counts["conflicts"] = checkpoint_store.blocked_count()
    if spec["dry_run"]:
        return counts
    quota_reclaim_bytes = await _reclaimable_missing_file_bytes(
        session_factory, spec, scan, previous,
        is_blocked=checkpoint_store.is_blocked,
    )
    group_counts = {name: 0 for name, _, _ in projection_phases(spec["allow_delete"])}
    for group_name, operations, object_type in projection_phases(spec["allow_delete"]):
        for candidate in iter_reconcile_candidates(
            scan.entries, previous, complete=scan.complete,
        ):
            entry = candidate.current or candidate.previous
            if (
                candidate.operation in operations and entry is not None
                and entry.object_type == object_type
                and not checkpoint_store.is_blocked(candidate.relative_path)
            ):
                group_counts[group_name] += 1
    total_groups = sum((count + batch_size - 1) // batch_size for count in group_counts.values())
    staged_generation = None
    published = False
    try:
        start_group = int(checkpoint_state.get("projection_group_index", 0))
        for index, (group_name, paths) in enumerate(
            projection_batches(
                scan, previous, spec["allow_delete"],
                is_blocked=checkpoint_store.is_blocked,
                batch_size=batch_size,
            ),
        ):
            if index < start_group:
                continue
            if time.monotonic() >= slice_deadline:
                raise ProjectionSliceExpired
            if not await check_active(
                session_factory, run_id, token, stop, deadline,
                binding_id=spec["binding_id"],
                binding_revision=spec["binding_revision"],
            ):
                raise TimeoutError("cancelled_or_timed_out")
            async with session_factory() as db:
                run = await db.get(FileSyncReconcileRun, run_id)
                binding = await db.scalar(select(FileSyncBinding).where(
                    FileSyncBinding.id == spec["binding_id"],
                ).with_for_update())
                if run is None or binding is None or run.lease_token != token or run.status != "running":
                    raise RuntimeError("lease_lost")
                if (
                    binding.scope_revision != spec["binding_revision"]
                    or binding.mode != spec["binding_mode"]
                    or binding.root_fingerprint != spec["root_fingerprint"]
                ):
                    raise RuntimeError("binding_changed")
                file_entries = {
                    path: scan.entries[path]
                    for path in paths
                    if path in scan.entries and scan.entries[path].object_type == "file"
                }
                latest_blocks = await inspect_conflict_batch(
                    db,
                    user_id=spec["user_id"],
                    binding=binding,
                    root=spec["root"],
                    user_root=spec["user_root"],
                    other_roots=spec["other_roots"],
                    candidate_paths=paths,
                    entries=file_entries,
                    persist=not spec["dry_run"],
                )
                checkpoint_store.block_paths(latest_blocks)
                counts["conflicts"] = checkpoint_store.blocked_count()
                safe_paths = [path for path in paths if path not in latest_blocks]
                if safe_paths:
                    batch = PathEventBatch()
                    getattr(batch, group_name).update(safe_paths)
                    summary = await project_path_events(
                        db, spec["user_id"], binding, spec["root"], batch,
                        allow_delete=True, scanned_entries=scan.entries,
                        mark_dirty=False, quota_reclaim_bytes=quota_reclaim_bytes,
                    )
                else:
                    summary = None
                event = None
                if summary is not None and summary.entity_ids:
                    event = await enqueue_file_event(
                        db, spec["user_id"], operation="refresh",
                        entity_ids=summary.entity_ids, source=FileSyncSource.LOCAL_DIRECTORY,
                        revision=binding.revision,
                    )
                if summary is not None:
                    if summary.rejected_paths:
                        # 未能投影的候选不得进入成功基线，否则配额/竞争拒绝会
                        # 被误判为已同步，后续每日差异也就不会再尝试。
                        checkpoint_store.block_paths(summary.rejected_paths)
                    counts["created"] += summary.created + summary.folders_created
                    counts["updated"] += summary.updated + summary.folders_updated
                    counts["moved"] += summary.moved
                    counts["deleted"] += summary.deleted + summary.folders_deleted
                    counts["rejected"] += summary.rejected
                record_run_progress(
                    run,
                    stage="projecting",
                    progress_current=index + 1,
                    progress_total=total_groups,
                    result_counts=dict(counts),
                )
                await db.commit()
                if event is not None:
                    await deliver_file_event(db, event)
                    await db.commit()
            checkpoint_state["projection_group_index"] = index + 1
            checkpoint_state["projection_counts"] = counts
            checkpoint_store.save_state(checkpoint_state)
            if time.monotonic() >= slice_deadline and index + 1 < total_groups:
                raise ProjectionSliceExpired
        if time.monotonic() >= slice_deadline:
            raise ProjectionSliceExpired
        # 成功基线要等所有投影结果都已知后再暂存，才能排除本轮被配额、
        # 路径替换或并发变更拒绝的候选；落盘移到线程，避免阻塞 Worker 事件环。
        baseline_store = FileSyncBaselineStore(spec["user_id"], spec["binding_id"])
        staged_generation = await asyncio.to_thread(
            baseline_store.stage,
            root_fingerprint=spec["root_fingerprint"],
            entries=iter_success_baseline_entries(
                scan.entries, previous, preserve_missing=not spec["allow_delete"],
                is_blocked=checkpoint_store.is_blocked,
            ),
        )
        if not await check_active(
            session_factory, run_id, token, stop, deadline,
            binding_id=spec["binding_id"],
            binding_revision=spec["binding_revision"],
        ):
            raise TimeoutError("cancelled_or_timed_out")
        async with session_factory() as db:
            run = await db.get(FileSyncReconcileRun, run_id)
            binding = await db.scalar(select(FileSyncBinding).where(
                FileSyncBinding.id == spec["binding_id"],
            ).with_for_update())
            if run is None or binding is None or run.lease_token != token or run.status != "running":
                raise RuntimeError("lease_lost")
            if (
                binding.scope_revision != spec["binding_revision"]
                or binding.mode != spec["binding_mode"]
                or binding.root_fingerprint != spec["root_fingerprint"]
            ):
                raise RuntimeError("binding_changed")
            if binding.dirty_revision != spec["dirty_revision"]:
                raise RuntimeError("dirty_revision_changed")
            # 所有整树投影 journal 不再推进 dirty_revision。CAS 失败时旧快照保留，
            # 下次扫描会以当前成功代次重新计算差异。
            binding.baseline_generation = staged_generation
            binding.baseline_dirty_revision = spec["dirty_revision"]
            clear_reconcile_gap_if_current(
                binding,
                gap_revision_at_start=run.gap_revision_at_start,
                mode=spec["mode"],
                dry_run=spec["dry_run"],
                allow_delete=spec["allow_delete"],
            )
            binding.last_reconciled_at = now_utc()
            if spec["reason"] == "daily":
                binding.last_daily_reconciled_at = now_utc()
            if spec["mode"] == "integrity_full" and spec["reason"] in {
                "bootstrap", "manual", "snapshot_invalid",
            }:
                binding.last_integrity_verified_at = now_utc()
            binding.consecutive_failures = 0
            binding.next_reconcile_at = now_utc() + timedelta(
                seconds=float(setting("compensation_interval_seconds", 86400.0)),
            )
            state = await db.get(FileSyncUserScanState, run.user_id)
            publish_scan_success(
                run, state, token=token, generation=staged_generation,
                counts=counts,
                slice_started=slice_started,
            )
            await db.commit()
            published = True
        try:
            FileSyncBaselineStore(spec["user_id"], spec["binding_id"]).prune({
                staged_generation,
                spec["baseline_generation"],
            })
        except OSError:
            pass
        return counts
    except Exception:
        if staged_generation is not None and not published:
            try:
                FileSyncBaselineStore(spec["user_id"], spec["binding_id"]).discard(staged_generation)
            except OSError:
                pass
        raise
