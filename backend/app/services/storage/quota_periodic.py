"""低频完整校准配额账本，正常读写只依赖增量账本。"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import redis as R
from app.core import scheduler
from app.core.tz import now_utc
from app.models import StorageQuotaLedger, User
from app.services.storage.quota_ledger import FILE_LIBRARY, reconcile_user_storage

_RECONCILE_INTERVAL = timedelta(days=7)
_BATCH_SIZE = 4
_LOCK_KEY = "storage:quota_reconcile:lock"


async def reconcile_due_storage_users(
    db: AsyncSession, *, now=None, batch_size: int = _BATCH_SIZE,
) -> int:
    """校准到期的活跃用户；每用户独立提交，单用户失败不阻塞其他用户。"""
    timestamp = now or now_utc()
    due_before = timestamp - _RECONCILE_INTERVAL
    query = select(User.id).join(
        StorageQuotaLedger,
        (StorageQuotaLedger.user_id == User.id)
        & (StorageQuotaLedger.category == FILE_LIBRARY),
    ).where(
        User.is_active.is_(True),
        StorageQuotaLedger.status == "active",
        (StorageQuotaLedger.last_reconciled_at.is_(None)
         | (StorageQuotaLedger.last_reconciled_at <= due_before)),
    ).order_by(StorageQuotaLedger.last_reconciled_at.asc().nullsfirst(), User.id.asc())
    user_ids = (await db.scalars(query.limit(max(1, batch_size)))).all()

    completed = 0
    for user_id in user_ids:
        try:
            await reconcile_user_storage(
                db, user_id, preserve_concurrent_updates=True,
            )
            await db.commit()
            completed += 1
        except Exception as exc:
            await db.rollback()
            from app.core.redaction import diag_log

            diag_log("storage.quota_periodic_reconcile", exc)
    return completed


@scheduler.register(
    scheduler.every(hours=1),
    id="storage_quota_periodic_reconcile",
    name="每周校准用户存储配额",
)
async def reconcile_due_storage_quotas() -> None:
    """每小时取最多四个到期用户；七天间隔由账本的校准时间持久维护。"""
    import app.db.session as db_session

    lock = R.get_redis().lock(_LOCK_KEY, timeout=900, blocking=False)
    if not await lock.acquire(blocking=False):
        return
    try:
        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            await reconcile_due_storage_users(db)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("storage.quota_periodic_reconcile", exc)
    finally:
        try:
            await lock.release()
        except Exception:
            pass
