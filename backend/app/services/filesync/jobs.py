"""手动文件同步任务的最小持久状态机。"""
from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.events import publish_filesync_binding_health_changed, publish_filesync_run_changed
from app.core.tz import now_utc
from app.models import FileSyncBinding, FileSyncReconcileRun

ACTIVE_BINDING_STATUSES = ("queued", "running", "cancelling")
RUNNING_STATUSES = ("running", "cancelling")
_CLAIM_LOCK_KEY = 731904267
_RUN_LEASE_SECONDS = 60
_EMPTY_RESULT_COUNTS = {
    "created": 0,
    "updated": 0,
    "moved": 0,
    "deleted": 0,
    "skipped": 0,
    "conflicts": 0,
    "failed": 0,
    "foldersCreated": 0,
    "foldersUpdated": 0,
    "foldersDeleted": 0,
    "plannedCreated": 0,
    "plannedUpdated": 0,
    "plannedDeleted": 0,
    "exported": 0,
}


class ReconcileRunError(ValueError):
    """可安全返回给调用方的任务状态错误。"""


async def notify_run_changed(
    row: FileSyncReconcileRun, *, coalesce: bool = False,
) -> None:
    """提交后发送轻量失效事件；任务快照仍以数据库为准。"""
    await publish_filesync_run_changed(
        row.user_id,
        run_id=str(row.id),
        binding_id=row.binding_id,
        revision=row.revision,
        coalesce=coalesce,
    )


async def enqueue_reconcile_run(
    db: AsyncSession,
    *,
    user_id,
    binding_id: int,
    action: str,
    allow_delete: bool = False,
) -> FileSyncReconcileRun:
    if action not in {"dry_run", "repair", "initialize", "mirror_out"}:
        raise ReconcileRunError("对账任务类型无效")
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.id == binding_id,
        FileSyncBinding.user_id == user_id,
    ).with_for_update())
    if binding is None or binding.source != "local_directory" or binding.status != "active":
        raise LookupError("同步绑定不存在")
    if (action == "mirror_out") != (binding.mode == "mirror_out"):
        raise ReconcileRunError("任务类型与同步方向不匹配")
    if action == "dry_run" and allow_delete:
        raise ReconcileRunError("预检任务不能应用删除")
    existing = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
        FileSyncReconcileRun.status.in_(ACTIVE_BINDING_STATUSES),
    ).order_by(FileSyncReconcileRun.created_at.desc()).limit(1))
    if existing is not None:
        if existing.status == "queued" and existing.action == action and existing.allow_delete == allow_delete:
            return existing
        raise ReconcileRunError("该同步绑定已有未完成任务")
    row = FileSyncReconcileRun(
        user_id=user_id,
        binding_id=binding.id,
        action=action,
        allow_delete=allow_delete,
        status="queued",
        binding_revision=binding.revision,
        gap_revision=binding.gap_revision,
        root_fingerprint=binding.root_fingerprint,
        result_counts=dict(_EMPTY_RESULT_COUNTS),
    )
    db.add(row)
    await db.flush()
    return row


async def get_reconcile_run(
    db: AsyncSession, run_id: UUID, *, user_id=None,
) -> FileSyncReconcileRun | None:
    query = select(FileSyncReconcileRun).where(FileSyncReconcileRun.id == run_id)
    if user_id is not None:
        query = query.where(FileSyncReconcileRun.user_id == user_id)
    return await db.scalar(query)


async def list_reconcile_runs(
    db: AsyncSession,
    *,
    user_id=None,
    binding_id: int | None = None,
    limit: int = 20,
) -> list[FileSyncReconcileRun]:
    query = select(FileSyncReconcileRun)
    if user_id is not None:
        query = query.where(FileSyncReconcileRun.user_id == user_id)
    if binding_id is not None:
        query = query.where(FileSyncReconcileRun.binding_id == binding_id)
    return list((await db.scalars(
        query.order_by(FileSyncReconcileRun.created_at.desc()).limit(max(1, min(100, limit)))
    )).all())


async def request_run_cancel(
    db: AsyncSession, run_id: UUID, *, user_id=None,
) -> FileSyncReconcileRun | None:
    query = select(FileSyncReconcileRun).where(FileSyncReconcileRun.id == run_id)
    if user_id is not None:
        query = query.where(FileSyncReconcileRun.user_id == user_id)
    row = await db.scalar(query.with_for_update())
    if row is None:
        return None
    timestamp = now_utc()
    if row.status == "queued":
        row.status = "cancelled"
        row.finished_at = timestamp
        row.stage = "cancelled"
        row.revision += 1
    elif row.status == "running":
        row.status = "cancelling"
        row.cancel_requested = True
        row.revision += 1
    await db.flush()
    return row


async def claim_next_run(
    db: AsyncSession,
    worker_id: str,
    *,
    now: datetime | None = None,
    concurrency: int | None = None,
    budget_seconds: int | None = None,
) -> FileSyncReconcileRun | None:
    """在事务锁下应用全局并发和同用户互斥，再原子领取最早的待运行任务。"""
    timestamp = now or now_utc()
    settings = get_settings().filesync
    concurrency = max(1, min(8, concurrency or settings.reconcile_max_concurrency))
    budget_seconds = max(60, min(7200, budget_seconds or settings.reconcile_execution_budget_seconds))
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        await db.execute(text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": _CLAIM_LOCK_KEY})

    # 不接管已失联任务：线程/事务可能仍在退出。租约过期只把任务变成明确失败，
    # 由用户显式重新从头发起，不自动重试或复用旧清单。
    expired_rows = list((await db.scalars(
        select(FileSyncReconcileRun).where(
            FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
            FileSyncReconcileRun.lease_until <= timestamp,
        ).with_for_update(skip_locked=True)
    )).all())
    for expired in expired_rows:
        expired.status = "failed"
        expired.stage = "failed"
        expired.error_code = "worker_interrupted"
        expired.finished_at = timestamp
        expired.lease_owner = None
        expired.lease_until = None
        expired.revision += 1
        expired.updated_at = timestamp
    await db.flush()

    async def notify_expired() -> None:
        for expired in expired_rows:
            await notify_run_changed(expired)

    active_count = int(await db.scalar(select(func.count()).select_from(FileSyncReconcileRun).where(
        FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
        FileSyncReconcileRun.lease_until > timestamp,
    )) or 0)
    if active_count >= concurrency:
        await db.commit()
        await notify_expired()
        return None
    active_users = select(FileSyncReconcileRun.user_id).where(
        FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
        FileSyncReconcileRun.lease_until > timestamp,
    )
    result = await db.execute(
        select(FileSyncReconcileRun)
        .where(
            FileSyncReconcileRun.status == "queued",
            ~FileSyncReconcileRun.user_id.in_(active_users),
        )
        .order_by(FileSyncReconcileRun.created_at, FileSyncReconcileRun.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    row = result.scalar_one_or_none()
    if row is None:
        await db.commit()
        await notify_expired()
        return None
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.id == row.binding_id,
        FileSyncBinding.user_id == row.user_id,
        FileSyncBinding.status == "active",
    ))
    if binding is None or binding.root_fingerprint != row.root_fingerprint:
        row.status = "failed"
        row.stage = "failed"
        row.error_code = "binding_changed"
        row.finished_at = timestamp
    else:
        row.status = "running"
        row.stage = "scanning"
        row.lease_owner = worker_id
        row.lease_until = timestamp + timedelta(seconds=_RUN_LEASE_SECONDS)
        row.deadline_at = timestamp + timedelta(seconds=budget_seconds)
        row.started_at = timestamp
    row.revision += 1
    row.updated_at = timestamp
    await db.commit()
    await notify_expired()
    await notify_run_changed(row)
    return row if row.status == "running" else None


async def renew_run_lease(
    db: AsyncSession,
    run_id: UUID,
    worker_id: str,
    *,
    now: datetime | None = None,
) -> bool:
    timestamp = now or now_utc()
    result = await db.execute(
        update(FileSyncReconcileRun)
        .where(
            FileSyncReconcileRun.id == run_id,
            FileSyncReconcileRun.lease_owner == worker_id,
            FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
        )
        .values(lease_until=timestamp + timedelta(seconds=_RUN_LEASE_SECONDS), updated_at=timestamp)
    )
    await db.commit()
    return result.rowcount == 1


async def finish_run(
    db: AsyncSession,
    run_id: UUID,
    worker_id: str,
    *,
    status: str,
    error_code: str | None = None,
    stage: str | None = None,
    requeue_mirror_out_changes: bool = False,
    reconciliation_complete: bool = False,
) -> bool:
    if status not in {"succeeded", "failed", "cancelled"}:
        raise ValueError("无效的任务终态")
    timestamp = now_utc()
    row = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.id == run_id,
        FileSyncReconcileRun.lease_owner == worker_id,
        FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
    ).with_for_update())
    if row is None:
        await db.rollback()
        return False
    # API 取消与 worker 收尾竞争时，已请求取消的任务不能再报告成功。
    if row.cancel_requested and status == "succeeded":
        status = "cancelled"
        error_code = None
    row.status = status
    row.stage = stage or status
    row.error_code = error_code
    row.lease_owner = None
    row.lease_until = None
    row.finished_at = timestamp
    row.revision += 1
    row.updated_at = timestamp
    await db.flush()
    if (
        status == "succeeded"
        and reconciliation_complete
        and row.action in {"repair", "initialize"}
    ):
        health_changed = await _record_reconciliation_completion(db, row, timestamp)
    else:
        health_changed = None
    if requeue_mirror_out_changes and status == "succeeded" and row.action == "mirror_out":
        await _requeue_mirror_out_changes(db, row)
    await db.commit()
    if health_changed is not None:
        await publish_filesync_binding_health_changed(
            health_changed[0], binding_id=health_changed[1], revision=health_changed[2],
        )
    await notify_run_changed(row)
    return True


async def _record_reconciliation_completion(
    db: AsyncSession,
    row: FileSyncReconcileRun,
    timestamp: datetime,
) -> tuple[object, int, int] | None:
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.id == row.binding_id,
        FileSyncBinding.user_id == row.user_id,
        FileSyncBinding.status == "active",
    ).with_for_update())
    if binding is None or binding.root_fingerprint != row.root_fingerprint:
        return None
    binding.last_reconciled_at = timestamp
    result_counts = row.result_counts or {}
    unresolved = any(int(result_counts.get(key, 0) or 0) for key in (
        "conflicts", "skipped", "failed",
    ))
    if (
        row.action == "repair"
        and binding.needs_reconcile
        and binding.gap_revision == row.gap_revision
        and not unresolved
    ):
        binding.needs_reconcile = False
        binding.health_revision += 1
        return binding.user_id, binding.id, binding.health_revision
    return None


async def _requeue_mirror_out_changes(
    db: AsyncSession,
    row: FileSyncReconcileRun,
) -> None:
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.id == row.binding_id,
        FileSyncBinding.user_id == row.user_id,
        FileSyncBinding.status == "active",
        FileSyncBinding.mode == "mirror_out",
    ).with_for_update())
    if (
        binding is None
        or binding.root_fingerprint != row.root_fingerprint
        or binding.revision <= row.binding_revision
    ):
        return
    db.add(FileSyncReconcileRun(
        user_id=row.user_id,
        binding_id=row.binding_id,
        action="mirror_out",
        allow_delete=False,
        status="queued",
        binding_revision=binding.revision,
        gap_revision=binding.gap_revision,
        root_fingerprint=binding.root_fingerprint,
        result_counts=dict(_EMPTY_RESULT_COUNTS),
    ))


def serialize_reconcile_run(row: FileSyncReconcileRun) -> dict:
    """返回不含物理路径、文件名或原始异常的权威任务快照。"""
    return {
        "id": str(row.id),
        "bindingId": row.binding_id,
        "action": row.action,
        "allowDelete": row.allow_delete,
        "status": row.status,
        "stage": row.stage,
        "scannedCount": row.scanned_count,
        "resultCounts": dict(row.result_counts or {}),
        "errorCode": row.error_code,
        "revision": row.revision,
        "cancelRequested": row.cancel_requested,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "startedAt": row.started_at.isoformat() if row.started_at else None,
        "finishedAt": row.finished_at.isoformat() if row.finished_at else None,
    }


async def update_run_progress(
    db: AsyncSession,
    run_id: UUID,
    worker_id: str,
    *,
    stage: str,
    scanned_count: int | None = None,
    result_counts: dict | None = None,
) -> bool:
    values = {"stage": stage, "revision": FileSyncReconcileRun.revision + 1, "updated_at": now_utc()}
    if scanned_count is not None:
        values["scanned_count"] = scanned_count
    if result_counts is not None:
        values["result_counts"] = result_counts
    result = await db.execute(update(FileSyncReconcileRun).where(
        FileSyncReconcileRun.id == run_id,
        FileSyncReconcileRun.lease_owner == worker_id,
        FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
    ).values(**values))
    changed = None
    if result.rowcount == 1:
        changed = (await db.execute(select(
            FileSyncReconcileRun.user_id,
            FileSyncReconcileRun.binding_id,
            FileSyncReconcileRun.revision,
        ).where(FileSyncReconcileRun.id == run_id))).one_or_none()
    await db.commit()
    if changed is not None:
        await publish_filesync_run_changed(
            changed.user_id,
            run_id=str(run_id),
            binding_id=changed.binding_id,
            revision=changed.revision,
            coalesce=True,
        )
    return result.rowcount == 1


async def cancellation_requested(db: AsyncSession, run_id: UUID, worker_id: str) -> bool:
    row = await db.scalar(select(FileSyncReconcileRun.cancel_requested).where(
        FileSyncReconcileRun.id == run_id,
        FileSyncReconcileRun.lease_owner == worker_id,
    ))
    return bool(row)
