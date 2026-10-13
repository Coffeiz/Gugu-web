"""低频完整校准配额账本，正常读写只依赖增量账本。"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import timedelta

from sqlalchemy import select

from app.core import redis as R
from app.core import scheduler
from app.core.tz import now_utc
from app.models import StorageQuotaLedger, User
from app.services.storage.quota_ledger import (
    FILE_LIBRARY, StorageScanBusyError, reconcile_user_storage,
)

_RECONCILE_INTERVAL = timedelta(days=7)
_PARALLEL_USERS = 4
_MAX_BUSY_RETRIES = 3
_LOCK_KEY = "storage:quota_reconcile:lock"
_LOCK_TTL_SECONDS = 900
_LOCK_RENEW_SECONDS = 300
_log = logging.getLogger("app.storage.quota_periodic")


async def reconcile_due_storage_users(
    session_factory, *, now=None, concurrency: int = _PARALLEL_USERS,
    stop_event: asyncio.Event | None = None,
    include_all_users: bool = False,
    progress_callback: Callable[[dict[str, int]], Awaitable[None]] | None = None,
) -> int:
    """持续校准用户配额；并发有界，每个完成槽位立即领取下一用户。

    手动全量对账包含所有用户，即使其账本尚未创建；周期任务仍只处理活跃且已到期账本。
    """
    if include_all_users:
        query = select(User.id).order_by(User.id.asc())
    else:
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
    async with session_factory() as db:
        user_ids = (await db.scalars(query)).all()

    completed = 0
    processed = 0
    failed = 0
    progress_lock = asyncio.Lock()
    if progress_callback:
        await progress_callback({
            "total": len(user_ids), "processed": 0, "completed": 0, "failed": 0,
        })
    if not user_ids:
        return completed

    queue: asyncio.Queue = asyncio.Queue()
    for user_id in user_ids:
        queue.put_nowait(user_id)
    for _ in range(max(1, concurrency)):
        queue.put_nowait(None)
    completed_lock = asyncio.Lock()

    async def worker() -> None:
        nonlocal completed, processed, failed
        while stop_event is None or not stop_event.is_set():
            user_id = await queue.get()
            if user_id is None:
                return
            busy_retries = 0
            succeeded = False
            while stop_event is None or not stop_event.is_set():
                try:
                    async with session_factory() as db:
                        await reconcile_user_storage(
                            db, user_id, preserve_concurrent_updates=True,
                        )
                        await db.commit()
                    async with completed_lock:
                        completed += 1
                    succeeded = True
                    break
                except asyncio.CancelledError:
                    raise
                except StorageScanBusyError as exc:
                    # 暂时有其他扫描占用时短暂重试，持续繁忙则留待下一轮调度。
                    busy_retries += 1
                    if busy_retries >= _MAX_BUSY_RETRIES:
                        from app.core.redaction import diag_log

                        diag_log("storage.quota_periodic_scan_busy", exc)
                        break
                    await asyncio.sleep(5)
                except Exception as exc:
                    from app.core.redaction import diag_log

                    diag_log("storage.quota_periodic_reconcile", exc)
                    break
            async with progress_lock:
                processed += 1
                if not succeeded:
                    failed += 1
                if progress_callback:
                    await progress_callback({
                        "total": len(user_ids), "processed": processed,
                        "completed": completed, "failed": failed,
                    })

    await asyncio.gather(*(worker() for _ in range(max(1, concurrency))))
    return completed


async def _renew_scheduler_lock(lock, stop_event: asyncio.Event,
                                lease_lost: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=_LOCK_RENEW_SECONDS)
            return
        except asyncio.TimeoutError:
            try:
                renewed = await lock.extend(_LOCK_TTL_SECONDS, replace_ttl=True)
            except Exception as exc:
                from app.core.redaction import diag_log

                diag_log("storage.quota_periodic_lock_renew", exc)
                renewed = False
            if not renewed:
                lease_lost.set()
                return


@scheduler.register(
    scheduler.every(hours=1),
    id="storage_quota_periodic_reconcile",
    name="每周校准用户存储配额",
)
async def reconcile_due_storage_quotas() -> None:
    """每小时持续处理到期用户，最多四个并行；七天间隔由账本校准时间维护。"""
    import app.db.session as db_session

    lock = R.get_redis().lock(_LOCK_KEY, timeout=_LOCK_TTL_SECONDS, blocking=False)
    if not await lock.acquire(blocking=False):
        return
    renew_stop = asyncio.Event()
    lease_lost = asyncio.Event()
    renew_task = asyncio.create_task(_renew_scheduler_lock(lock, renew_stop, lease_lost))
    try:
        db_session.ensure_engine()
        completed = await reconcile_due_storage_users(
            db_session._SessionLocal, stop_event=lease_lost,
        )
        _log.info("周期配额对账完成 completed=%s", completed)
    except Exception as exc:
        from app.core.redaction import diag_log

        diag_log("storage.quota_periodic_reconcile", exc)
    finally:
        renew_stop.set()
        renew_task.cancel()
        await asyncio.gather(renew_task, return_exceptions=True)
        try:
            await lock.release()
        except Exception:
            pass
