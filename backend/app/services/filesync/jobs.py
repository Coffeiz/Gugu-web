"""手动文件同步任务的最小持久状态机。"""
from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
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
    await db.execute(
        update(FileSyncReconcileRun)
        .where(
            FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
            FileSyncReconcileRun.lease_until <= timestamp,
        )
        .values(status="failed", stage="failed", error_code="worker_interrupted",
                finished_at=timestamp, lease_owner=None, lease_until=None,
                revision=FileSyncReconcileRun.revision + 1, updated_at=timestamp)
    )
    active_count = int(await db.scalar(select(func.count()).select_from(FileSyncReconcileRun).where(
        FileSyncReconcileRun.status.in_(RUNNING_STATUSES),
        FileSyncReconcileRun.lease_until > timestamp,
    )) or 0)
    if active_count >= concurrency:
        await db.commit()
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
    if requeue_mirror_out_changes and status == "succeeded" and row.action == "mirror_out":
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.id == row.binding_id,
            FileSyncBinding.user_id == row.user_id,
            FileSyncBinding.status == "active",
            FileSyncBinding.mode == "mirror_out",
        ).with_for_update())
        if (
            binding is not None
            and binding.root_fingerprint == row.root_fingerprint
            and binding.revision > row.binding_revision
        ):
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
    await db.commit()
    return True


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
    await db.commit()
    return result.rowcount == 1


async def cancellation_requested(db: AsyncSession, run_id: UUID, worker_id: str) -> bool:
    row = await db.scalar(select(FileSyncReconcileRun.cancel_requested).where(
        FileSyncReconcileRun.id == run_id,
        FileSyncReconcileRun.lease_owner == worker_id,
    ))
    return bool(row)
