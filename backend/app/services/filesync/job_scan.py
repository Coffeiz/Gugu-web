"""持久对账任务的可恢复扫描与检查点流程。"""
from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping
from uuid import UUID

from app.services.filesync.baseline import FileSyncBaselineStore
from app.services.filesync.checkpoint import ScanCheckpointStore
from app.services.filesync.job_spec import ReconcileJobSpec
from app.services.filesync.scan import (
    FINGERPRINT_VERSION, ScanControl, ScanEntry, ScanResult,
)


@dataclass(slots=True)
class ScanExecutionContext:
    """一个租约片段的扫描状态；不包含 ORM 实例，可安全传入扫描线程。"""

    spec: ReconcileJobSpec
    run_id: UUID
    token: UUID
    stop: threading.Event
    execution_deadline: float
    slice_started: float
    checkpoint_store: ScanCheckpointStore
    checkpoint_state: dict
    checkpoint_entries: Mapping[str, ScanEntry]
    checkpoint_scope: dict
    previous: Mapping[str, ScanEntry]


@dataclass(frozen=True, slots=True)
class ScanExecutionRuntime:
    """片段执行依赖，与持久任务的可变检查点状态分离。"""

    session_factory: Callable
    scan_tree: Callable
    persist_progress: Callable
    pause_run: Callable
    setting: Callable
    hash_gate: object
    scan_batch_size: int
    slice_seconds: float
    monotonic: Callable = time.monotonic


def prepare_scan_execution(
    spec: ReconcileJobSpec,
    run_id: UUID,
    token: UUID,
    stop: threading.Event,
    execution_deadline: float,
    slice_started: float,
    *,
    setting: Callable,
) -> ScanExecutionContext:
    """加载并校验基线/检查点，使续跑只复用同一绑定版本的候选扫描。"""
    checkpoint_store = ScanCheckpointStore(
        spec["user_id"], spec["binding_id"], run_id,
    )
    try:
        checkpoint_state, checkpoint_entries = checkpoint_store.load()
        checkpoint_scope = {
            "scope": {
                "checkpoint_schema": 2,
                "root_fingerprint": spec["root_fingerprint"],
                "binding_revision": spec["binding_revision"],
                "baseline_generation": spec["baseline_generation"],
                "fingerprint_version": FINGERPRINT_VERSION,
                "hash_chunk_bytes": int(setting("reconcile_hash_chunk_bytes", 1_048_576)),
                "mode": spec["mode"],
                "binding_mode": spec["binding_mode"],
                "force_integrity_scan": spec["force_integrity_scan"],
            },
        }
        if checkpoint_state and checkpoint_state.get("scope") != checkpoint_scope["scope"]:
            checkpoint_store.reset()
            checkpoint_state, checkpoint_entries = {}, {}

        previous: Mapping[str, ScanEntry] = {}
        if spec["baseline_generation"]:
            baseline_store = FileSyncBaselineStore(spec["user_id"], spec["binding_id"])
            try:
                previous = baseline_store.load(
                    spec["baseline_generation"],
                    expected_root_fingerprint=spec["root_fingerprint"],
                ).entries
            except (OSError, ValueError):
                spec["mode"] = "integrity_full"
                previous = {}

        # 基线损坏可能把本轮提升为 integrity_full；旧模式下的候选不能续用。
        expected_scope = {**checkpoint_scope["scope"], "mode": spec["mode"]}
        if checkpoint_state and checkpoint_state.get("scope") != expected_scope:
            checkpoint_store.reset()
            checkpoint_state, checkpoint_entries = {}, {}

        if (
            checkpoint_state
            and checkpoint_state.get("scan_dirty_revision") != spec["dirty_revision"]
        ):
            # 扫描期间新增真实文件事件，清除旧候选并重新核对脏水位。
            checkpoint_state = {
                "scope": expected_scope,
                "mode": spec["mode"],
                "scan_dirty_revision": spec["dirty_revision"],
            }
            checkpoint_store.reset()
            checkpoint_store.save(checkpoint_state, {})
            checkpoint_state, checkpoint_entries = checkpoint_store.load()

        return ScanExecutionContext(
            spec=spec,
            run_id=run_id,
            token=token,
            stop=stop,
            execution_deadline=execution_deadline,
            slice_started=slice_started,
            checkpoint_store=checkpoint_store,
            checkpoint_state=checkpoint_state,
            checkpoint_entries=checkpoint_entries,
            checkpoint_scope=checkpoint_scope,
            previous=previous,
        )
    except Exception:
        checkpoint_store.close()
        raise


async def scan_or_resume(
    context: ScanExecutionContext,
    runtime: ScanExecutionRuntime,
) -> ScanResult | None:
    """恢复完整候选，或执行一个有预算的扫描片段；None 表示已持久暂停。"""
    spec = context.spec
    await runtime.persist_progress(
        runtime.session_factory, context.run_id, context.token,
        stage="scanning", mode=spec["mode"],
    )
    if context.checkpoint_state.get("scan_complete") is True:
        scan = _completed_scan(context)
    else:
        scan = await _run_scan_segment(context, runtime)
        if not scan.complete:
            await _pause_incomplete_scan(context, runtime, scan)
            return None
        _commit_completed_scan(context, scan)
    await _persist_scan_progress(runtime, context, scan)
    return scan


def _completed_scan(context: ScanExecutionContext) -> ScanResult:
    state = context.checkpoint_state
    return ScanResult(
        context.checkpoint_entries,
        True,
        int(state.get("file_count", 0)),
        int(state.get("directory_count", 0)),
        int(state.get("hashed_count", 0)),
        int(state.get("rejected_count", 0)),
    )


async def _run_scan_segment(
    context: ScanExecutionContext, runtime: ScanExecutionRuntime,
) -> ScanResult:
    spec = context.spec
    store = context.checkpoint_store
    slice_deadline = min(
        context.execution_deadline,
        context.slice_started + runtime.slice_seconds,
    )
    store.begin_scan_segment()
    scan_task = asyncio.create_task(asyncio.to_thread(
        runtime.scan_tree,
        spec["root"],
        user_root=spec["user_root"],
        previous=context.previous,
        integrity_full=(spec["mode"] == "integrity_full" or spec["force_integrity_scan"]),
        force_hash_paths=spec["dirty_paths"],
        hash_chunk_bytes=int(runtime.setting("reconcile_hash_chunk_bytes", 1_048_576)),
        hash_gate=runtime.hash_gate,
        checkpoint_state=context.checkpoint_state,
        checkpoint_entries=context.checkpoint_entries,
        checkpoint_queue=store.pending_directories,
        max_entries=runtime.scan_batch_size,
        control=ScanControl(slice_deadline, context.stop),
    ))
    try:
        return await asyncio.shield(scan_task)
    except asyncio.CancelledError:
        context.stop.set()
        try:
            await asyncio.shield(scan_task)
        finally:
            store.rollback_scan_segment()
        raise


async def _pause_incomplete_scan(
    context: ScanExecutionContext,
    runtime: ScanExecutionRuntime,
    scan: ScanResult,
) -> None:
    if scan.error_code == "cancelled":
        raise TimeoutError("cancelled")
    if scan.error_code != "slice_expired" or scan.checkpoint_state is None:
        raise RuntimeError(scan.error_code or "scan_incomplete")
    context.checkpoint_store.commit_scan_segment({
        **scan.checkpoint_state,
        **context.checkpoint_scope,
        "mode": context.spec["mode"],
        "scan_dirty_revision": context.spec["dirty_revision"],
    })
    await _persist_scan_progress(runtime, context, scan)
    await runtime.pause_run(
        runtime.session_factory, context.run_id, context.token,
        reason=(
            "execution_budget"
            if runtime.monotonic() >= context.execution_deadline else "scan_slice"
        ),
        slice_started=context.slice_started,
    )


def _commit_completed_scan(context: ScanExecutionContext, scan: ScanResult) -> None:
    state = {
        **context.checkpoint_scope,
        "mode": context.spec["mode"],
        "scan_dirty_revision": context.spec["dirty_revision"],
        "scan_complete": True,
        "file_count": scan.file_count,
        "directory_count": scan.directory_count,
        "hashed_count": scan.hashed_count,
        "rejected_count": scan.rejected_count,
    }
    context.checkpoint_store.commit_scan_segment(state)
    context.checkpoint_state = state


async def _persist_scan_progress(
    runtime: ScanExecutionRuntime, context: ScanExecutionContext, scan: ScanResult,
) -> None:
    await runtime.persist_progress(
        runtime.session_factory, context.run_id, context.token,
        stage="scanning",
        progress_current=scan.file_count + scan.directory_count,
        progress_total=None,
        result_counts={
            "scanned": scan.file_count + scan.directory_count,
            "hashed": scan.hashed_count,
            "reused": scan.file_count - scan.hashed_count,
            "rejected": scan.rejected_count,
        },
    )
