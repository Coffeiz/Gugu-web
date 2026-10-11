"""持久化、全局限并发的回收站清理任务。"""

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.core.redaction import diag_log
from app.core.redis import get_redis
from app.models import File, Folder, TrashPurgeJob
from app.services.files.trash import (
    list_deleted_files,
    list_deleted_folders,
    permanently_delete_file,
    permanently_delete_folder,
)
from app.services.files.previews import delete_thumb_cache
from app.services.storage import get_storage

_log = logging.getLogger("app.files.trash_purge")
_LEASE = timedelta(minutes=2)
_WAKE_CHANNEL = "jobs:trash-purge:wakeup"
_RECOVERY_SCAN_SECONDS = 30
_COOLDOWN = timedelta(seconds=30)
_BATCH_SIZE = 10


async def _notify_worker() -> None:
    """Redis 只负责唤醒；任务已持久化，通知失败时由恢复扫描兜底。"""
    try:
        await asyncio.wait_for(get_redis().publish(_WAKE_CHANNEL, "1"), timeout=0.5)
    except Exception as exc:
        _log.debug("回收站 worker 唤醒通知失败 error=%s", type(exc).__name__)


async def _listen_for_wakeup(pubsub, wake_event: asyncio.Event) -> None:
    try:
        async for message in pubsub.listen():
            if message.get("type") == "message":
                wake_event.set()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        diag_log("files.trash_purge.wakeup", exc)
        _log.warning("回收站 worker 通知连接失败 error=%s", type(exc).__name__)
    finally:
        # 让调度循环立即重连；任务状态仍以数据库为准。
        wake_event.set()


async def _open_wakeup_subscription(wake_event: asyncio.Event):
    pubsub = None
    try:
        pubsub = get_redis().pubsub()
        await asyncio.wait_for(pubsub.subscribe(_WAKE_CHANNEL), timeout=1)
        return pubsub, asyncio.create_task(_listen_for_wakeup(pubsub, wake_event))
    except asyncio.CancelledError:
        if pubsub is not None:
            await pubsub.aclose()
        raise
    except Exception as exc:
        diag_log("files.trash_purge.subscribe", exc)
        _log.warning("回收站 worker 通知订阅失败 error=%s", type(exc).__name__)
        if pubsub is not None:
            try:
                await pubsub.aclose()
            except Exception:
                pass
        return None, None


async def _close_wakeup_subscription(pubsub, listener) -> None:
    if listener is not None:
        listener.cancel()
        await asyncio.gather(listener, return_exceptions=True)
    if pubsub is not None:
        try:
            await pubsub.unsubscribe(_WAKE_CHANNEL)
        except Exception:
            pass
        try:
            await pubsub.aclose()
        except Exception:
            pass


async def _wait_for_work_or_stop(wake_event, stop_event, timeout: float) -> None:
    wake_task = asyncio.create_task(wake_event.wait())
    stop_task = asyncio.create_task(stop_event.wait())
    try:
        await asyncio.wait(
            (wake_task, stop_task),
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for task in (wake_task, stop_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(wake_task, stop_task, return_exceptions=True)


async def get_active_job(db: AsyncSession, user_id) -> TrashPurgeJob | None:
    return (await db.execute(
        select(TrashPurgeJob).where(
            TrashPurgeJob.user_id == user_id,
            TrashPurgeJob.status.in_(("queued", "running")),
        ).order_by(TrashPurgeJob.created_at.desc()).limit(1)
    )).scalar_one_or_none()


async def get_owned_job(db: AsyncSession, user_id, job_id: int) -> TrashPurgeJob | None:
    return (await db.execute(select(TrashPurgeJob).where(
        TrashPurgeJob.id == job_id,
        TrashPurgeJob.user_id == user_id,
    ))).scalar_one_or_none()


async def enqueue_purge(db: AsyncSession, user_id) -> tuple[TrashPurgeJob, bool]:
    """返回 (任务, 是否新建)；活动任务幂等复用，短时间重复请求拒绝。"""
    active = await get_active_job(db, user_id)
    if active:
        return active, False

    latest = (await db.execute(select(TrashPurgeJob).where(
        TrashPurgeJob.user_id == user_id,
        TrashPurgeJob.status.in_(("completed", "failed")),
    ).order_by(TrashPurgeJob.created_at.desc()).limit(1))).scalar_one_or_none()
    now = now_utc()
    if (latest and latest.status == "completed" and latest.progress_total > 0 and latest.finished_at
            and now - latest.finished_at < _COOLDOWN):
        raise TimeoutError

    parent = Folder
    standalone_files = (await db.execute(
        select(func.count(File.id))
        .outerjoin(parent, File.folder_id == parent.id)
        .where(
            File.user_id == user_id,
            File.deleted_at.isnot(None),
            or_(File.folder_id.is_(None), parent.deleted_at.is_(None)),
        )
    )).scalar_one()
    parent_alias = Folder.__table__.alias("trash_parent_folder")
    top_folders = (await db.execute(
        select(func.count(Folder.id))
        .outerjoin(parent_alias, Folder.parent_id == parent_alias.c.id)
        .where(
            Folder.user_id == user_id,
            Folder.deleted_at.isnot(None),
            or_(Folder.parent_id.is_(None), parent_alias.c.deleted_at.is_(None)),
        )
    )).scalar_one()

    job = TrashPurgeJob(
        user_id=user_id,
        status="queued",
        snapshot_at=now,
        progress_total=int(standalone_files) + int(top_folders),
    )
    if job.progress_total == 0:
        job.status = "completed"
        job.finished_at = now
    db.add(job)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        active = await get_active_job(db, user_id)
        if active:
            return active, False
        raise
    await db.refresh(job)
    if job.status == "queued":
        await _notify_worker()
    return job, True


async def _claim(session_factory, worker_id: str) -> int | None:
    async with session_factory() as db:
        now = now_utc()
        running = (await db.execute(select(TrashPurgeJob.id).where(
            TrashPurgeJob.status == "running",
            TrashPurgeJob.lease_until > now,
        ).limit(1))).scalar_one_or_none()
        if running is not None:
            return None
        candidates = await db.execute(
            select(TrashPurgeJob)
            .where(
                TrashPurgeJob.status == "running",
                or_(TrashPurgeJob.lease_until <= now, TrashPurgeJob.lease_until.is_(None)),
            )
            .order_by(TrashPurgeJob.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        job = candidates.scalar_one_or_none()
        if job is None:
            job = (await db.execute(
                select(TrashPurgeJob)
                .where(TrashPurgeJob.status == "queued")
                .order_by(TrashPurgeJob.created_at)
                .with_for_update(skip_locked=True)
                .limit(1)
            )).scalar_one_or_none()
        if job is None:
            return None
        job.status = "running"
        job.lease_owner = worker_id
        job.lease_until = now + _LEASE
        if job.started_at is None:
            job.started_at = now
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            # 数据库唯一部分索引是跨进程的最终互斥保障；并发 worker 输掉 claim 时
            # 视为没有可领取任务，而不是把正常竞争记成 worker 故障。
            running_id = (await db.execute(select(TrashPurgeJob.id).where(
                TrashPurgeJob.status == 'running',
                TrashPurgeJob.lease_until > now,
            ).limit(1))).scalar_one_or_none()
            if running_id is None:
                raise
            return None
        return job.id


async def _fail(
    db: AsyncSession, job_id: int, owner: str, error_code: str,
) -> TrashPurgeJob | None:
    job = await db.get(TrashPurgeJob, job_id)
    if job and job.status == "running" and job.lease_owner == owner:
        job.status = "failed"
        job.failed_count += 1
        job.error_code = error_code
        job.finished_at = now_utc()
        job.lease_owner = None
        job.lease_until = None
        await db.commit()
        return job
    return None


async def _renew_lease_in_session(
    db: AsyncSession, job_id: int, owner: str, now=None,
) -> bool:
    now = now or now_utc()
    with db.no_autoflush:
        result = await db.execute(update(TrashPurgeJob).where(
            TrashPurgeJob.id == job_id,
            TrashPurgeJob.status == "running",
            TrashPurgeJob.lease_owner == owner,
            TrashPurgeJob.lease_until > now,
        ).values(lease_until=now + _LEASE))
    return result.rowcount == 1


async def _maintain_lease(job_id: int, owner: str, session_factory, lost: asyncio.Event) -> None:
    interval = max(0.05, _LEASE.total_seconds() / 3)
    while True:
        await asyncio.sleep(interval)
        try:
            async with session_factory() as db:
                renewed = await _renew_lease_in_session(db, job_id, owner)
                await db.commit()
            if not renewed:
                lost.set()
                return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            diag_log("files.trash_purge.lease", exc)


async def _next_batch(db: AsyncSession, job: TrashPurgeJob) -> list[tuple[str, int]]:
    files = await list_deleted_files(
        db, job.user_id, _BATCH_SIZE, deleted_before=job.snapshot_at
    )
    if files:
        return [("file", item.id) for item in files]
    folders = await list_deleted_folders(
        db, job.user_id, _BATCH_SIZE, deleted_before=job.snapshot_at
    )
    return [("folder", item.id) for item in folders]


async def _delete_batch(
    db: AsyncSession, job: TrashPurgeJob, work: list[tuple[str, int]], storage
) -> None:
    for kind, item_id in work:
        if kind == "file":
            deleted_id = await permanently_delete_file(db, storage, job.user_id, item_id)
            if deleted_id is not None:
                delete_thumb_cache(deleted_id)
        else:
            folder = (await db.execute(select(Folder).where(
                Folder.id == item_id,
                Folder.user_id == job.user_id,
                Folder.deleted_at.isnot(None),
            ))).scalar_one_or_none()
            if folder is not None:
                deleted_ids = await permanently_delete_folder(db, storage, folder)
                for deleted_id in deleted_ids:
                    delete_thumb_cache(deleted_id)
        job.progress_current += 1
    now = now_utc()
    if not await _renew_lease_in_session(db, job.id, job.lease_owner, now):
        raise RuntimeError("回收站清理任务租约已失效")
    job.lease_until = now + _LEASE
    await db.commit()


async def _complete(db: AsyncSession, job: TrashPurgeJob) -> None:
    now = now_utc()
    with db.no_autoflush:
        result = await db.execute(update(TrashPurgeJob).where(
            TrashPurgeJob.id == job.id,
            TrashPurgeJob.status == "running",
            TrashPurgeJob.lease_owner == job.lease_owner,
            TrashPurgeJob.lease_until > now,
        ).values(
            status="completed", error_code=None, finished_at=now,
            lease_owner=None, lease_until=None,
        ))
    if result.rowcount != 1:
        raise RuntimeError("回收站清理任务租约已失效")
    await db.refresh(job)
    await db.commit()


async def _process(job_id: int, worker_id: str, session_factory) -> None:
    from app.core import events

    storage = get_storage()
    user_id = None
    lease_lost = asyncio.Event()
    lease_task = asyncio.create_task(_maintain_lease(job_id, worker_id, session_factory, lease_lost))
    try:
        while True:
            async with session_factory() as db:
                job = await db.get(TrashPurgeJob, job_id)
                if not job or job.status != "running" or job.lease_owner != worker_id or lease_lost.is_set():
                    return
                user_id = job.user_id
                work = await _next_batch(db, job)
                if not work:
                    await _complete(db, job)
                    await events.publish_trash_purge_progress(
                        user_id, job_id=job.id, status=job.status,
                        progress_current=job.progress_current,
                        progress_total=job.progress_total, failed_count=job.failed_count,
                    )
                    break
                try:
                    await _delete_batch(db, job, work, storage)
                    await events.publish_trash_purge_progress(
                        user_id, job_id=job.id, status=job.status,
                        progress_current=job.progress_current,
                        progress_total=job.progress_total, failed_count=job.failed_count,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    await db.rollback()
                    diag_log("files.trash_purge.process", exc)
                    _log.warning("回收站清理任务失败 job_id=%s error=%s", job_id, type(exc).__name__)
                    failed_job = await _fail(db, job_id, worker_id, "purge_failed")
                    if failed_job is not None:
                        await events.publish_trash_purge_progress(
                            failed_job.user_id, job_id=failed_job.id, status=failed_job.status,
                            progress_current=failed_job.progress_current,
                            progress_total=failed_job.progress_total,
                            failed_count=failed_job.failed_count,
                        )
                    return
    finally:
        lease_task.cancel()
        await asyncio.gather(lease_task, return_exceptions=True)

    if user_id is not None:
        await events.publish(user_id, "files")


async def run_trash_purge_worker(stop_event, *, worker_id: str, session_factory) -> None:
    """有任务时由 Redis 唤醒；数据库恢复扫描保证通知丢失后仍可接管。"""
    wake_event = asyncio.Event()
    pubsub = listener = None
    try:
        while not stop_event.is_set():
            if listener is None or listener.done():
                await _close_wakeup_subscription(pubsub, listener)
                pubsub, listener = await _open_wakeup_subscription(wake_event)

            wake_event.clear()
            try:
                job_id = await _claim(session_factory, worker_id)
                if job_id is not None:
                    await _process(job_id, worker_id, session_factory)
                    continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                diag_log("files.trash_purge.worker", exc)
                _log.warning("回收站 worker 领取任务失败 error=%s", type(exc).__name__)

            # 通知连接断开时立即回到循环重连；Redis 不可用时最多每 30 秒查库一次。
            if listener is not None and listener.done():
                wake_event.set()
            await _wait_for_work_or_stop(
                wake_event, stop_event, _RECOVERY_SCAN_SECONDS,
            )
    finally:
        await _close_wakeup_subscription(pubsub, listener)
