"""持久文件对账任务的到期筛选与用户周期调度。"""
from __future__ import annotations

from datetime import timedelta
from typing import Callable

from sqlalchemy import func, or_, select

from app.core.tz import now_utc
from app.models import (
    FileSyncBinding, FileSyncReconcileRun, FileSyncUserScanState,
)
from app.services.filesync.activity import evaluate_daily_cycle
from app.services.filesync.job_lifecycle import cancel_daily_run
from app.services.filesync.protocol import FileSyncMode, FileSyncSource


async def enqueue_due_jobs(
    session_factory,
    *,
    enqueue_reconcile: Callable,
    setting: Callable,
) -> None:
    """按用户小批轮转；任务创建委托给共享的持久任务入口。"""
    if not setting("background_reconcile_enabled", True):
        return
    now = now_utc()
    async with session_factory() as db:
        interval = float(setting("compensation_interval_seconds", 86400.0))
        user_limit = max(1, int(setting("reconcile_user_batch_size", 8)))
        # 先在 DB 端选一小批到期用户，避免把全站绑定一次加载进 Python。
        eligible_user_rows = (await db.execute(
            select(
                FileSyncBinding.user_id,
                FileSyncUserScanState.last_rotation_at,
                func.min(FileSyncBinding.next_reconcile_at).label("next_due_at"),
            ).outerjoin(
                FileSyncUserScanState,
                FileSyncUserScanState.user_id == FileSyncBinding.user_id,
            ).where(
                FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
                FileSyncBinding.status == "active",
                or_(
                    (
                        FileSyncBinding.baseline_generation.is_(None)
                        & (FileSyncBinding.mode != FileSyncMode.MIRROR_OUT)
                    ),
                    FileSyncBinding.next_reconcile_at.is_(None),
                    FileSyncBinding.next_reconcile_at <= now,
                ),
            ).group_by(
                FileSyncBinding.user_id,
                FileSyncUserScanState.last_rotation_at,
            ).order_by(
                FileSyncUserScanState.last_rotation_at.asc().nulls_first(),
                func.min(FileSyncBinding.next_reconcile_at).asc().nulls_first(),
                FileSyncBinding.user_id,
            ).limit(user_limit)
        )).all()
        selected_user_ids = [row.user_id for row in eligible_user_rows]
        if not selected_user_ids:
            await db.commit()
            return
        bindings = (await db.scalars(select(FileSyncBinding).where(
            FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
            FileSyncBinding.status == "active",
            FileSyncBinding.user_id.in_(selected_user_ids),
        ))).all()
        by_user: dict[object, list[FileSyncBinding]] = {}
        for binding in bindings:
            by_user.setdefault(binding.user_id, []).append(binding)

        for user_id, user_bindings in by_user.items():
            state = await db.get(FileSyncUserScanState, user_id)
            if state is None:
                state = FileSyncUserScanState(user_id=user_id)
                db.add(state)
                await db.flush()
            state.last_rotation_at = now

            # 首次基线和异常恢复不受每日活跃跳过。
            for binding in user_bindings:
                if binding.mode == FileSyncMode.MIRROR_OUT and binding.next_reconcile_at is None:
                    await enqueue_reconcile(
                        db, binding, mode=FileSyncMode.MIRROR_OUT, reason="bootstrap",
                    )
                elif not binding.baseline_generation and (
                    binding.next_reconcile_at is None or binding.next_reconcile_at <= now
                ):
                    await enqueue_reconcile(
                        db, binding, mode="integrity_full", reason="bootstrap",
                    )

            decision = await evaluate_daily_cycle(
                db, state, now=now, interval_seconds=interval,
            )
            if decision == "skipped_file_active":
                for binding in user_bindings:
                    due = binding.next_reconcile_at is None or binding.next_reconcile_at <= now
                    if binding.mode == FileSyncMode.MIRROR_OUT:
                        if due:
                            await enqueue_reconcile(
                                db, binding, mode=FileSyncMode.MIRROR_OUT,
                                reason=(
                                    "file_event"
                                    if binding.dirty_revision > binding.baseline_dirty_revision
                                    else "daily"
                                ),
                            )
                        continue
                    if binding.baseline_generation and due:
                        run = await db.scalar(select(FileSyncReconcileRun).where(
                            FileSyncReconcileRun.binding_id == binding.id,
                            FileSyncReconcileRun.reason == "daily",
                            FileSyncReconcileRun.status.in_(
                                ("queued", "running", "paused", "cancelling"),
                            ),
                        ).with_for_update())
                        if run is not None and (
                            run.status != "queued" or run.started_at is not None
                        ):
                            continue
                        if run is None:
                            run = FileSyncReconcileRun(
                                user_id=user_id,
                                binding_id=binding.id,
                                mode="snapshot_diff",
                                reason="daily",
                            )
                            cancel_daily_run(run, now=now)
                            db.add(run)
                        else:
                            cancel_daily_run(run, now=now)
                        binding.next_reconcile_at = state.current_cycle_cutoff + timedelta(
                            seconds=interval,
                        )
                continue
            if decision != "scan":
                continue
            for binding in user_bindings:
                if (
                    (binding.baseline_generation or binding.mode == FileSyncMode.MIRROR_OUT)
                    and (binding.next_reconcile_at is None or binding.next_reconcile_at <= now)
                ):
                    await enqueue_reconcile(
                        db, binding,
                        mode=(
                            FileSyncMode.MIRROR_OUT
                            if binding.mode == FileSyncMode.MIRROR_OUT
                            else "snapshot_diff"
                        ),
                        reason=(
                            "file_event"
                            if binding.mode == FileSyncMode.MIRROR_OUT
                            and binding.dirty_revision > binding.baseline_dirty_revision
                            else "daily"
                        ),
                    )
        await db.commit()
