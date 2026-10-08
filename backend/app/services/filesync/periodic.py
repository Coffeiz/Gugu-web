"""周期性完整核对：复用持久化任务队列，不在调度器中直接扫描文件树。"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import scheduler
from app.core.config import get_settings
from app.core.tz import now_utc
from app.models import FileSyncBinding, FileSyncReconcileRun, User
from app.services.filesync.jobs import ReconcileRunError, enqueue_reconcile_run

_RECONCILE_INTERVAL = timedelta(days=7)
_FAILED_RETRY_INTERVAL = timedelta(hours=24)
_BATCH_SIZE = 64


async def enqueue_due_weekly_reconciles(
    db: AsyncSession, *, now=None, batch_size: int = _BATCH_SIZE,
) -> int:
    """将到期活跃绑定排入完整修复任务；失败任务限频，任务本身保持可取消。"""
    settings = get_settings().filesync
    if not settings.enabled:
        return 0

    timestamp = now or now_utc()
    window_days = int(settings.active_window_days)
    active_users = select(User.id).where(User.is_active.is_(True))
    if window_days > 0:
        active_users = active_users.where(
            User.last_active_at >= timestamp - timedelta(days=window_days),
        )

    due_before = timestamp - _RECONCILE_INTERVAL
    query = select(FileSyncBinding).where(
        FileSyncBinding.user_id.in_(active_users),
        FileSyncBinding.source == "local_directory",
        FileSyncBinding.status == "active",
        FileSyncBinding.mode != "mirror_out",
        (FileSyncBinding.last_reconciled_at.is_(None)
         | (FileSyncBinding.last_reconciled_at <= due_before)),
    ).order_by(FileSyncBinding.last_reconciled_at.asc().nullsfirst(), FileSyncBinding.id.asc())
    bindings = (await db.scalars(query.limit(max(1, batch_size)).with_for_update(skip_locked=True))).all()

    retry_after = timestamp - _FAILED_RETRY_INTERVAL
    enqueued = 0
    for binding in bindings:
        recent_terminal_failure = await db.scalar(select(FileSyncReconcileRun.id).where(
            FileSyncReconcileRun.binding_id == binding.id,
            FileSyncReconcileRun.action == "repair",
            FileSyncReconcileRun.status.in_(("failed", "cancelled")),
            FileSyncReconcileRun.finished_at >= retry_after,
        ).limit(1))
        if recent_terminal_failure is not None:
            continue
        try:
            await enqueue_reconcile_run(
                db,
                user_id=binding.user_id,
                binding_id=binding.id,
                action="repair",
                # 周期任务先只应用新增/更新；缺失行的自动软删除待明确授权。
                allow_delete=False,
            )
        except (LookupError, ReconcileRunError):
            # 并发手动任务或绑定状态变化时，下次调度再检查，不影响其他绑定。
            continue
        enqueued += 1

    if enqueued:
        await db.commit()
    else:
        await db.rollback()
    return enqueued


@scheduler.register(
    scheduler.every(hours=1),
    id="filesync_weekly_full_reconcile",
    name="文件同步每周完整核对",
)
async def enqueue_weekly_reconciles() -> None:
    """每小时检查到期绑定；用持久化完成时间维持七天间隔，重启不丢调度。"""
    import app.db.session as db_session

    db_session.ensure_engine()
    try:
        async with db_session._SessionLocal() as db:
            await enqueue_due_weekly_reconciles(db)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("filesync.periodic_reconcile", exc)
