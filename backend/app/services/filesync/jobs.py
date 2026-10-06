"""持久化文件对账任务；目录扫描和正文哈希始终在数据库 session 外执行。"""
from __future__ import annotations

import asyncio
import random
import threading
import time
from pathlib import Path
from typing import Mapping
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.core.config import get_settings
from app.models import (
    File, FileSyncBinding, FileSyncJournal,
    FileSyncReconcileRun, FileSyncUserScanState,
)
from app.services.filesync.baseline import FileSyncBaselineStore
from app.services.filesync.checkpoint import ScanCheckpointStore
from app.services.filesync.job_spec import ReconcileJobSpec
from app.services.filesync.job_scan import (
    ScanExecutionRuntime,
    prepare_scan_execution,
    scan_or_resume,
)
from app.services.filesync.job_errors import ProjectionSliceExpired as _ProjectionSliceExpired
from app.services.filesync.job_lifecycle import (
    THREAD_STOPS as _THREAD_STOPS,
    claim_due_job as _claim_due_job,
    enqueue_reconcile,
    finish as _lifecycle_finish,
    heartbeat as _heartbeat,
    pause_run as _lifecycle_pause_run,
    persist_run_progress as _persist_run_progress,
    request_job_cancel,
)
from app.services.filesync.job_mirror_out import (
    MirrorOutExecution,
    MirrorOutRuntime,
    apply_mirror_out_segment as _apply_mirror_out_segment_impl,
)
from app.services.filesync.job_scheduler import enqueue_due_jobs as _enqueue_due_jobs_impl
from app.services.filesync.job_projection import (
    ScanProjectionExecution,
    ScanProjectionRuntime,
    apply_scan_projection as _apply_scan_projection,
)
from app.services.filesync.protocol import (
    FileSyncMode,
)
from app.services.filesync.scan import (
    ScanEntry, ScanResult, scan_binding_tree,
)

_HASH_GATES: dict[int, threading.BoundedSemaphore] = {}
_HASH_GATES_LOCK = threading.Lock()
_WRITE_GATES: dict[tuple[int, int], asyncio.Semaphore] = {}
_DIRTY_PATH_MEMORY_LIMIT = 10_000


def _setting(name: str, default):
    config = getattr(get_settings(), "filesync", None)
    return getattr(config, name, default)


def _hash_gate() -> threading.BoundedSemaphore:
    limit = max(1, int(_setting("reconcile_hash_concurrency", 1)))
    with _HASH_GATES_LOCK:
        return _HASH_GATES.setdefault(limit, threading.BoundedSemaphore(limit))


def _write_gate() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    limit = max(1, int(_setting("reconcile_write_concurrency", 1)))
    return _WRITE_GATES.setdefault((id(loop), limit), asyncio.Semaphore(limit))


def _timeout_seconds() -> float:
    return float(_setting("reconcile_timeout_seconds", 1800.0))


def _slice_seconds() -> float:
    return min(
        float(_setting("reconcile_slice_seconds", 10.0)),
        _timeout_seconds(),
    )


def _scan_batch_size() -> int:
    return max(1, int(_setting("reconcile_scan_batch_size", 1000)))


def _batch_size() -> int:
    return max(1, int(_setting("reconcile_batch_size", 200)))


async def claim_due_job(db: AsyncSession) -> tuple[UUID, UUID] | None:
    return await _claim_due_job(
        db,
        timeout_seconds=_timeout_seconds,
        allow_background=bool(_setting("background_reconcile_enabled", True)),
    )


async def _binding_root(db: AsyncSession, binding: FileSyncBinding):
    if binding.workspace_id is not None:
        from app.services.workspaces import resolve_workspace_root

        return await resolve_workspace_root(db, binding.user_id, binding.workspace_id)
    from app.services.filesync.bindings import resolve_local_binding_root

    try:
        _, root = resolve_local_binding_root(binding.user_id, binding.root_path)
        return root
    except (OSError, ValueError):
        return None




async def _finish(
    session_factory,
    run_id: UUID,
    token: UUID,
    *,
    status: str,
    error_code: str | None = None,
    counts: dict | None = None,
    slice_started: float | None = None,
):
    await _lifecycle_finish(
        session_factory, run_id, token,
        status=status, error_code=error_code, counts=counts,
        slice_started=slice_started, setting=_setting, enqueue=enqueue_reconcile,
        monotonic=time.monotonic, jitter=random.uniform,
    )


async def _pause_run(
    session_factory,
    run_id: UUID,
    token: UUID,
    *,
    reason: str,
    slice_started: float,
) -> None:
    await _lifecycle_pause_run(
        session_factory, run_id, token,
        reason=reason, slice_started=slice_started, monotonic=time.monotonic,
    )


async def _load_run_spec(
    session_factory, run_id: UUID, token: UUID,
) -> ReconcileJobSpec | None:
    async with session_factory() as db:
        run = await db.get(FileSyncReconcileRun, run_id)
        if run is None or run.lease_token != token or run.status != "running":
            return None
        binding = await db.get(FileSyncBinding, run.binding_id)
        if binding is None or binding.status != "active":
            return None
        if run.binding_revision != binding.scope_revision:
            raise RuntimeError("binding_changed")
        root = await _binding_root(db, binding)
        if root is None:
            return None
        from app.services.filesync.bindings import _other_binding_roots

        other_roots = tuple(await _other_binding_roots(db, binding.user_id, binding))
        dirty_filter = (
            FileSyncJournal.binding_id == binding.id,
            FileSyncJournal.user_id == binding.user_id,
            FileSyncJournal.dirty_revision > int(binding.baseline_dirty_revision or 0),
        )
        dirty_count = int(await db.scalar(
            select(func.count()).select_from(FileSyncJournal).where(*dirty_filter),
        ) or 0)
        force_integrity_scan = dirty_count > _DIRTY_PATH_MEMORY_LIMIT
        dirty_paths = () if force_integrity_scan else await db.scalars(
            select(FileSyncJournal.relative_path).where(*dirty_filter)
            .order_by(FileSyncJournal.dirty_revision)
            .limit(_DIRTY_PATH_MEMORY_LIMIT)
        )
        return {
            "run_id": run.id, "token": token, "user_id": run.user_id,
            "binding_id": binding.id, "workspace_id": binding.workspace_id,
            "binding_mode": binding.mode,
            "root_path": binding.root_path, "root_fingerprint": binding.root_fingerprint,
            "binding_revision": binding.scope_revision,
            "baseline_generation": binding.baseline_generation,
            "last_reconciled_at": binding.last_reconciled_at,
            # 固定在逻辑任务首次领取时；所有暂停续跑沿用同一源端截止点。
            "export_cutoff": run.started_at,
            "dirty_revision": binding.dirty_revision,
            "mode": run.mode, "reason": run.reason, "root": root,
            "other_roots": other_roots,
            "result_counts": run.result_counts or {},
            "dry_run": run.dry_run,
            "allow_delete": run.allow_delete,
            "deadline_at": run.deadline_at,
            "user_root": Path(get_settings().storage.local_path).expanduser().resolve() / str(binding.user_id),
            "baseline_dirty_revision": binding.baseline_dirty_revision,
            # Journal 路径只用于要求当前版本重哈希；过多时改为全量哈希，避免
            # 把无限增长的事件集合一次性放入任务内存。
            "dirty_paths": frozenset(dirty_paths),
            "force_integrity_scan": force_integrity_scan,
            "checkpoint_ref": run.checkpoint_ref,
        }


async def _check_active(
    session_factory, run_id: UUID, token: UUID, stop: threading.Event,
    deadline: float, *, binding_id: int | None = None,
    binding_revision: int | None = None,
) -> bool:
    if stop.is_set() or time.monotonic() >= deadline:
        return False
    async with session_factory() as db:
        run = await db.get(FileSyncReconcileRun, run_id)
        if not (run and run.lease_token == token and run.status == "running"):
            return False
        if binding_id is not None and binding_revision is not None:
            binding = await db.get(FileSyncBinding, binding_id)
            if binding is None or binding.scope_revision != binding_revision:
                raise RuntimeError("binding_changed")
        return True


async def _apply_scan(
    execution: ScanProjectionExecution,
) -> dict:
    return await _apply_scan_projection(
        execution,
        ScanProjectionRuntime(
            check_active=_check_active,
            setting=_setting,
            batch_size=_batch_size(),
        ),
    )



async def _apply_mirror_out_segment(
    session_factory,
    spec: ReconcileJobSpec,
    stop: threading.Event,
    deadline: float,
    *,
    slice_deadline: float,
    slice_started: float,
) -> None:
    await _apply_mirror_out_segment_impl(
        MirrorOutExecution(
            session_factory=session_factory,
            spec=spec,
            stop=stop,
            deadline=deadline,
            slice_deadline=slice_deadline,
            slice_started=slice_started,
        ),
        MirrorOutRuntime(
            check_active=_check_active,
            finish_run=_finish,
            batch_size=_batch_size(),
        ),
    )


async def _run_claimed(session_factory, run_id: UUID, token: UUID) -> None:
    stop = threading.Event()
    key = str(run_id)
    _THREAD_STOPS[key] = stop
    heartbeat_stop = asyncio.Event()
    heartbeat = asyncio.create_task(_heartbeat(session_factory, run_id, token, heartbeat_stop))
    checkpoint_store = None
    slice_started = time.monotonic()
    try:
        spec = await _load_run_spec(session_factory, run_id, token)
        if spec is None:
            await _finish(
                session_factory, run_id, token,
                status="failed", error_code="binding_unavailable",
                slice_started=slice_started,
            )
            return
        remaining = max(0.0, (spec["deadline_at"] - now_utc()).total_seconds())
        execution_deadline = time.monotonic() + remaining
        if spec["mode"] == FileSyncMode.MIRROR_OUT:
            await _apply_mirror_out_segment(
                session_factory, spec, stop,
                execution_deadline,
                slice_deadline=slice_started + _slice_seconds(),
                slice_started=slice_started,
            )
            return
        scan_context = prepare_scan_execution(
            spec, run_id, token, stop, execution_deadline, slice_started,
            setting=_setting,
        )
        checkpoint_store = scan_context.checkpoint_store
        scan_runtime = ScanExecutionRuntime(
            session_factory=session_factory,
            scan_tree=scan_binding_tree,
            persist_progress=_persist_run_progress,
            pause_run=_pause_run,
            setting=_setting,
            hash_gate=_hash_gate(),
            scan_batch_size=_scan_batch_size(),
            slice_seconds=_slice_seconds(),
            monotonic=time.monotonic,
        )
        scan = await scan_or_resume(
            scan_context,
            scan_runtime,
        )
        if scan is None:
            return
        slice_deadline = slice_started + _slice_seconds()
        async with _write_gate():
            counts = await _apply_scan(
                ScanProjectionExecution(
                    session_factory=session_factory,
                    spec=spec,
                    scan=scan,
                    previous=scan_context.previous,
                    stop=stop,
                    deadline=execution_deadline,
                    slice_deadline=slice_deadline,
                    slice_started=slice_started,
                    checkpoint_store=checkpoint_store,
                    checkpoint_state=scan_context.checkpoint_state,
                ),
            )
        if spec["dry_run"]:
            await _finish(
                session_factory, run_id, token,
                status="succeeded", counts=counts, slice_started=slice_started,
            )
        checkpoint_store.discard()
        # `_apply_scan` 与成功状态在同一事务中完成快照 CAS 发布。
    except _ProjectionSliceExpired:
        await _pause_run(
            session_factory, run_id, token,
            reason=(
                "execution_budget"
                if "execution_deadline" in locals()
                and time.monotonic() >= execution_deadline
                else "projection_slice"
            ),
            slice_started=slice_started,
        )
    except TimeoutError:
        if checkpoint_store is not None:
            checkpoint_store.rollback_scan_segment()
        async with session_factory() as db:
            row = await db.get(FileSyncReconcileRun, run_id)
            cancelled = bool(row and row.status == "cancelling")
        if cancelled or stop.is_set():
            await _finish(
                session_factory, run_id, token,
                status="cancelled", error_code="cancelled", slice_started=slice_started,
            )
            if checkpoint_store is not None:
                checkpoint_store.discard()
        else:
            await _pause_run(
                session_factory, run_id, token, reason="execution_budget",
                slice_started=slice_started,
            )
    except Exception as exc:
        if checkpoint_store is not None:
            checkpoint_store.rollback_scan_segment()
        code = str(exc) if str(exc) in {
            "lease_lost", "binding_changed", "dirty_revision_changed", "scan_incomplete",
        } else "reconcile_failed"
        if code == "binding_changed":
            await _finish(
                session_factory, run_id, token,
                status="interrupted", error_code=code, slice_started=slice_started,
            )
            return
        if code == "dirty_revision_changed":
            await _pause_run(
                session_factory, run_id, token, reason="dirty_events",
                slice_started=slice_started,
            )
            return
        await _finish(
            session_factory, run_id, token,
            status="failed", error_code=code, slice_started=slice_started,
        )
    except asyncio.CancelledError:
        stop.set()
        if checkpoint_store is not None:
            checkpoint_store.rollback_scan_segment()
        raise
    finally:
        stop.set()
        if checkpoint_store is not None:
            checkpoint_store.close()
        heartbeat_stop.set()
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        _THREAD_STOPS.pop(key, None)


async def enqueue_due_jobs(session_factory) -> None:
    await _enqueue_due_jobs_impl(
        session_factory, enqueue_reconcile=enqueue_reconcile, setting=_setting,
    )



async def run_reconcile_jobs(stop_event: asyncio.Event, *, session_factory) -> None:
    """有界领取用户任务；暂停后台任务时，手动任务仍可执行。"""
    active: set[asyncio.Task] = set()
    try:
        while not stop_event.is_set():
            try:
                if _setting("background_reconcile_enabled", True):
                    await enqueue_due_jobs(session_factory)
                concurrency = max(1, int(_setting("reconcile_concurrency", 1)))
                while len(active) < concurrency and not stop_event.is_set():
                    async with session_factory() as db:
                        claim = await claim_due_job(db)
                    if claim is None:
                        break
                    active.add(asyncio.create_task(_run_claimed(session_factory, *claim)))
                if active:
                    done, active = await asyncio.wait(
                        active, timeout=1, return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in done:
                        task.result()
                else:
                    await asyncio.wait_for(stop_event.wait(), timeout=5)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(2)
    finally:
        if active:
            # 已启动任务在片段边界保存游标后退出，避免停机直接丢弃进度。
            await asyncio.gather(*active, return_exceptions=True)
