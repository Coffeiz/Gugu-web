"""持久对账任务的状态、租约与终态转换。"""
from __future__ import annotations

import asyncio
import random
import threading
import time
from datetime import timedelta
from typing import Callable
from uuid import UUID, uuid4

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import (
    FileSyncBinding, FileSyncReconcileRun, FileSyncUserScanState,
)
from app.services.filesync.protocol import FileSyncMode
from app.services.filesync.scheduling import (
    binding_rotation_order, effective_priority_order, mark_binding_claimed,
)

LEASE_SECONDS = 120
BACKOFF_SECONDS = (60, 300, 900, 3600)
BACKOFF_JITTER_RATIO = 0.1
ACTIVE_STATUSES = ("queued", "running", "paused", "cancelling")
THREAD_STOPS: dict[str, threading.Event] = {}


def record_run_progress(
    run: FileSyncReconcileRun,
    *,
    stage: str,
    progress_current: int | None = None,
    progress_total: int | None = None,
    result_counts: dict | None = None,
    checkpoint_ref: str | None = None,
    mode: str | None = None,
) -> None:
    """集中更新运行阶段和可观察进度；调用方需在任务状态有效的事务中使用。"""
    run.stage = stage
    if progress_current is not None:
        run.progress_current = progress_current
    run.progress_total = progress_total
    if result_counts is not None:
        run.result_counts = result_counts
    if checkpoint_ref is not None:
        run.checkpoint_ref = checkpoint_ref
    if mode is not None:
        run.mode = mode


async def persist_run_progress(
    session_factory,
    run_id: UUID,
    token: UUID,
    *,
    stage: str,
    progress_current: int | None = None,
    progress_total: int | None = None,
    result_counts: dict | None = None,
    mode: str | None = None,
) -> bool:
    """按租约更新任务进度；已取消或租约丢失时不覆盖终态。"""
    async with session_factory() as db:
        run = await db.get(FileSyncReconcileRun, run_id)
        if run is None or run.lease_token != token or run.status != "running":
            return False
        record_run_progress(
            run,
            stage=stage,
            progress_current=progress_current,
            progress_total=progress_total,
            result_counts=result_counts,
            mode=mode,
        )
        await db.commit()
        return True


async def enqueue_reconcile(
    db: AsyncSession,
    binding: FileSyncBinding,
    *,
    mode: str = "snapshot_diff",
    reason: str = "manual",
    dry_run: bool = False,
    allow_delete: bool = True,
) -> FileSyncReconcileRun:
    """合并同绑定请求并处理绑定版本变化。"""
    if binding.mode == FileSyncMode.MIRROR_OUT:
        mode = FileSyncMode.MIRROR_OUT
    if mode not in {"snapshot_diff", "integrity_full", FileSyncMode.MIRROR_OUT}:
        raise ValueError("对账模式无效")
    if reason not in {
        "bootstrap", "daily", "file_event", "event_fallback", "restart_recovery",
        "manual", "snapshot_invalid",
    }:
        raise ValueError("对账原因无效")
    active = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
        FileSyncReconcileRun.status.in_(ACTIVE_STATUSES),
    ).order_by(FileSyncReconcileRun.created_at.desc()).limit(1))
    if active is not None and active.binding_revision != binding.scope_revision:
        token = active.lease_token
        stop = THREAD_STOPS.get(str(active.id))
        if stop is not None:
            stop.set()
        active.status = "interrupted"
        active.stage = "finished"
        active.error_code = "binding_changed"
        active.finished_at = now_utc()
        active.lease_token = None
        active.lease_until = None
        active.next_run_at = None
        if token is not None:
            user_state = await db.get(FileSyncUserScanState, active.user_id)
            if user_state is not None and user_state.lease_token == token:
                user_state.lease_token = None
                user_state.lease_until = None
        await db.flush()
        active = None
    if active is not None:
        if mode == "integrity_full":
            active.mode = mode
        active.dry_run = bool(active.dry_run and dry_run)
        active.allow_delete = bool(active.allow_delete and allow_delete)
        if active.reason != "manual":
            active.reason = reason
        if active.status == "paused":
            active.status = "queued"
            active.pause_reason = None
            active.next_run_at = None
        return active
    row = FileSyncReconcileRun(
        user_id=binding.user_id,
        binding_id=binding.id,
        mode=mode,
        reason=reason,
        dry_run=dry_run,
        allow_delete=allow_delete,
        status="queued",
        binding_revision=binding.scope_revision,
        dirty_revision=binding.dirty_revision,
        priority_since=now_utc(),
        result_counts={},
    )
    nested = await db.begin_nested()
    db.add(row)
    try:
        await db.flush()
        await nested.commit()
    except IntegrityError:
        await nested.rollback()
        active = await db.scalar(select(FileSyncReconcileRun).where(
            FileSyncReconcileRun.binding_id == binding.id,
            FileSyncReconcileRun.status.in_(ACTIVE_STATUSES),
        ).order_by(FileSyncReconcileRun.created_at.desc()).limit(1))
        if active is None:
            raise
        return active
    return row


async def request_job_cancel(
    db: AsyncSession, *, user_id, run_id: UUID,
) -> FileSyncReconcileRun | None:
    conditions = [FileSyncReconcileRun.id == run_id]
    if user_id is not None:
        conditions.append(FileSyncReconcileRun.user_id == user_id)
    row = await db.scalar(select(FileSyncReconcileRun).where(*conditions))
    if row is None:
        return None
    if row.status in {"queued", "paused"}:
        row.status = "cancelled"
        row.stage = "finished"
        row.error_code = "cancelled"
        row.pause_reason = None
        row.next_run_at = None
        row.lease_token = None
        row.lease_until = None
        row.finished_at = now_utc()
    elif row.status in {"running", "cancelling"}:
        row.status = "cancelling"
        stop = THREAD_STOPS.get(str(row.id))
        if stop is not None:
            stop.set()
    await db.flush()
    return row


async def cancel_binding_jobs(db: AsyncSession, binding_id: int) -> int:
    """取消绑定下尚未结束的任务；运行中的任务通过 stop 信号安全退出。"""
    rows = (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding_id,
        FileSyncReconcileRun.status.in_(ACTIVE_STATUSES),
    ).with_for_update())).all()
    for row in rows:
        await request_job_cancel(db, user_id=None, run_id=row.id)
    return len(rows)


async def claim_due_job(
    db: AsyncSession,
    *,
    timeout_seconds: Callable[[], float],
    allow_background: bool = True,
) -> tuple[UUID, UUID] | None:
    now = now_utc()
    while True:
        row = await db.scalar(select(FileSyncReconcileRun).outerjoin(
            FileSyncUserScanState,
            FileSyncUserScanState.user_id == FileSyncReconcileRun.user_id,
        ).where(
            or_(
                FileSyncReconcileRun.status == "queued",
                (FileSyncReconcileRun.status == "paused")
                & (FileSyncReconcileRun.next_run_at <= now),
                (FileSyncReconcileRun.status == "running")
                & (FileSyncReconcileRun.lease_until < now),
                (FileSyncReconcileRun.status == "cancelling")
                & (FileSyncReconcileRun.lease_until < now),
            ),
            *(
                () if allow_background
                else (FileSyncReconcileRun.reason == "manual",)
            ),
            ~select(FileSyncUserScanState.user_id).where(
                FileSyncUserScanState.user_id == FileSyncReconcileRun.user_id,
                FileSyncUserScanState.lease_until.is_not(None),
                FileSyncUserScanState.lease_until > now,
            ).correlate(FileSyncReconcileRun).exists(),
        ).order_by(
            effective_priority_order(now),
            FileSyncUserScanState.last_rotation_at.asc().nulls_first(),
            *binding_rotation_order(),
            FileSyncReconcileRun.created_at,
        ).with_for_update(of=FileSyncReconcileRun, skip_locked=True).limit(1))
        if row is None:
            return None
        user_state = await db.get(
            FileSyncUserScanState, row.user_id, with_for_update=True,
        )
        if user_state is None:
            nested = await db.begin_nested()
            user_state = FileSyncUserScanState(user_id=row.user_id)
            db.add(user_state)
            # 首个扫描任务可能由多个 Worker 同时领取；如果状态行尚不存在，
            # 普通 INSERT 会让竞争者在主键上失败。用 savepoint 隔离冲突，
            # 冲突方回滚插入后再锁住胜出者创建的状态行。
            try:
                await db.flush()
                await nested.commit()
            except IntegrityError:
                await nested.rollback()
                user_state = await db.scalar(select(FileSyncUserScanState).where(
                    FileSyncUserScanState.user_id == row.user_id,
                ).with_for_update())
                if user_state is None:
                    raise
        now = now_utc()
        # 候选任务与用户槽位加锁之间，另一 Worker 可能先领取了该用户的其他绑定；
        # 在锁定用户状态后复查，不能覆盖仍有效的租约。
        if user_state.lease_until is not None and user_state.lease_until > now:
            await db.rollback()
            continue
        if row.status == "cancelling":
            # 取消请求后进程退出时，租约过期后收敛为终态，不重启已取消任务。
            cancelled_token = row.lease_token
            row.status = "cancelled"
            row.stage = "finished"
            row.error_code = "cancelled"
            row.finished_at = now
            row.lease_token = None
            row.lease_until = None
            row.next_run_at = None
            row.pause_reason = None
            if user_state.lease_token == cancelled_token:
                user_state.lease_token = None
                user_state.lease_until = None
            user_state.last_rotation_at = now
            await db.commit()
            continue
        queued_daily = (
            row.status == "queued" and row.started_at is None and row.reason == "daily"
        )
        newly_active = bool(
            queued_daily and user_state.activity_reliable
            and user_state.activity_seq != user_state.cycle_activity_seq
        )
        if newly_active:
            user_state.previous_cycle_cutoff = user_state.current_cycle_cutoff
            user_state.current_cycle_cutoff = now
            user_state.cycle_activity_seq = user_state.activity_seq
            user_state.last_cycle_decision = "skipped_file_active"
            user_state.skip_reason = "file_activity"
            user_state.updated_at = now
            queued_runs = (await db.scalars(select(FileSyncReconcileRun).where(
                FileSyncReconcileRun.user_id == row.user_id,
                FileSyncReconcileRun.reason == "daily",
                FileSyncReconcileRun.status == "queued",
                FileSyncReconcileRun.started_at.is_(None),
            ).with_for_update())).all()
            for queued_run in queued_runs:
                queued_run.status = "cancelled"
                queued_run.error_code = "skipped_file_active"
                queued_run.stage = "finished"
                queued_run.finished_at = now
            await db.commit()
            continue
        break
    binding = await db.get(FileSyncBinding, row.binding_id, with_for_update=True)
    if binding is None or binding.status != "active":
        now = now_utc()
        row.status = "cancelled"
        row.stage = "finished"
        row.error_code = "binding_inactive"
        row.finished_at = now
        row.lease_token = None
        row.lease_until = None
        row.next_run_at = None
        row.pause_reason = None
        user_state.last_rotation_at = now
        await db.commit()
        return None
    first_claim = row.started_at is None
    # cutoff 与文件库水位必须在绑定行锁后一起取样，避免领取前后水位错配。
    now = now_utc()
    token = uuid4()
    row.status = "running"
    row.stage = "claiming"
    row.lease_token = token
    row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
    row.deadline_at = now + timedelta(seconds=timeout_seconds())
    row.slice_started_at = now
    row.pause_reason = None
    row.next_run_at = None
    row.started_at = row.started_at or now
    if binding is not None and first_claim:
        row.dirty_revision = int(binding.dirty_revision or 0)
    user_state.lease_token = token
    user_state.lease_until = row.lease_until
    user_state.last_rotation_at = now
    mark_binding_claimed(user_state, row.binding_id)
    await db.commit()
    return row.id, token


async def heartbeat(
    session_factory, run_id: UUID, token: UUID, stop: asyncio.Event,
) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=15)
            return
        except asyncio.TimeoutError:
            pass
        async with session_factory() as db:
            row = await db.get(FileSyncReconcileRun, run_id)
            if row is None or row.lease_token != token or row.status != "running":
                return
            row.lease_until = now_utc() + timedelta(seconds=LEASE_SECONDS)
            state = await db.get(FileSyncUserScanState, row.user_id)
            if state is not None and state.lease_token == token:
                state.lease_until = row.lease_until
            await db.commit()


async def finish(
    session_factory,
    run_id: UUID,
    token: UUID,
    *,
    status: str,
    error_code: str | None = None,
    counts: dict | None = None,
    slice_started: float | None = None,
    setting: Callable,
    enqueue: Callable,
    monotonic: Callable[[], float] = time.monotonic,
    jitter: Callable[[float, float], float] = random.uniform,
) -> None:
    async with session_factory() as db:
        row = await db.get(FileSyncReconcileRun, run_id)
        if row is None or row.lease_token != token:
            return
        if slice_started is not None:
            row.cumulative_runtime_seconds = float(
                row.cumulative_runtime_seconds or 0,
            ) + max(0.0, monotonic() - slice_started)
        row.status = status
        row.stage = "finished"
        row.error_code = error_code
        row.result_counts = counts or row.result_counts or {}
        row.finished_at = now_utc() if status in {
            "succeeded", "failed", "cancelled", "interrupted",
        } else None
        row.lease_until = None
        row.next_run_at = None
        row.pause_reason = None
        state = await db.get(FileSyncUserScanState, row.user_id)
        if state is not None and state.lease_token == token:
            state.lease_token = None
            state.lease_until = None
            state.last_rotation_at = now_utc()
        if status == "succeeded" and not row.dry_run:
            binding = await db.scalar(select(FileSyncBinding).where(
                FileSyncBinding.id == row.binding_id,
            ).with_for_update())
            if binding is not None:
                binding.last_reconciled_at = (
                    row.started_at
                    if row.mode == FileSyncMode.MIRROR_OUT and row.started_at is not None
                    else now_utc()
                )
                if row.reason == "daily":
                    binding.last_daily_reconciled_at = now_utc()
                if row.mode == "integrity_full" and row.reason in {
                    "bootstrap", "manual", "snapshot_invalid",
                }:
                    binding.last_integrity_verified_at = now_utc()
                binding.consecutive_failures = 0
                binding.next_reconcile_at = now_utc() + timedelta(
                    seconds=float(setting("compensation_interval_seconds", 86400.0)),
                )
                if row.mode == FileSyncMode.MIRROR_OUT:
                    binding.baseline_dirty_revision = row.dirty_revision
                    if binding.dirty_revision > row.dirty_revision:
                        binding.next_reconcile_at = now_utc()
                        await db.flush()
                        await enqueue(
                            db, binding, mode=FileSyncMode.MIRROR_OUT,
                            reason="file_event",
                        )
        elif status == "failed":
            binding = await db.get(FileSyncBinding, row.binding_id)
            if binding is not None:
                binding.consecutive_failures = int(binding.consecutive_failures or 0) + 1
                delay = BACKOFF_SECONDS[min(
                    binding.consecutive_failures - 1, len(BACKOFF_SECONDS) - 1,
                )]
                delay *= jitter(
                    1 - BACKOFF_JITTER_RATIO,
                    1 + BACKOFF_JITTER_RATIO,
                )
                binding.next_reconcile_at = now_utc() + timedelta(seconds=delay)
        await db.commit()


async def pause_run(
    session_factory,
    run_id: UUID,
    token: UUID,
    *,
    reason: str,
    slice_started: float,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    async with session_factory() as db:
        row = await db.get(FileSyncReconcileRun, run_id)
        if row is None or row.lease_token != token:
            return
        if row.status == "cancelling":
            row.status = "cancelled"
            row.finished_at = now_utc()
            row.error_code = "cancelled"
        else:
            row.status = "paused"
            row.stage = "paused"
            row.pause_reason = reason
            row.next_run_at = now_utc() + timedelta(seconds=1)
            row.finished_at = None
            row.error_code = None
            if row.mode != FileSyncMode.MIRROR_OUT:
                row.checkpoint_ref = "sqlite-v1"
        row.cumulative_runtime_seconds = float(row.cumulative_runtime_seconds or 0) + max(
            0.0, monotonic() - slice_started,
        )
        row.lease_token = None
        row.lease_until = None
        state = await db.get(FileSyncUserScanState, row.user_id)
        if state is not None and state.lease_token == token:
            state.lease_token = None
            state.lease_until = None
            state.last_rotation_at = now_utc()
        await db.commit()


def publish_scan_success(
    run: FileSyncReconcileRun,
    state: FileSyncUserScanState | None,
    *,
    token: UUID,
    generation: str,
    counts: dict,
    slice_started: float,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    """在基线 CAS 已验证的同一事务内完成成功与租约收尾。"""
    run.candidate_generation = generation
    run.result_counts = counts
    run.cumulative_runtime_seconds = float(
        run.cumulative_runtime_seconds or 0,
    ) + max(0.0, monotonic() - slice_started)
    run.status = "succeeded"
    run.stage = "finished"
    run.finished_at = now_utc()
    run.lease_until = None
    if state is not None and state.lease_token == token:
        state.lease_token = None
        state.lease_until = None


def cancel_daily_run(run: FileSyncReconcileRun, *, now) -> None:
    """结束尚未领取的每日任务；调用方在持有对应行锁的事务中提交。"""
    run.status = "cancelled"
    run.stage = "finished"
    run.error_code = "skipped_file_active"
    run.finished_at = now
    run.lease_token = None
    run.lease_until = None
