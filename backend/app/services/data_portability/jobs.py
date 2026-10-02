"""可移植归档任务的持久化 claim 与租约状态转换。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import DataExportJob, DataImportJob

JobKind = Literal["export", "import"]
_LEASE_SECONDS = 90


@dataclass(frozen=True)
class ClaimedJob:
    kind: JobKind
    job_id: UUID
    user_id: UUID
    mode: str
    stage: str | None


async def claim_next_job(
    db: AsyncSession,
    worker_id: str,
    *,
    now: datetime | None = None,
    lease_seconds: int = _LEASE_SECONDS,
    include_imports: bool = True,
) -> ClaimedJob | None:
    """按创建时间 claim 一项排队或租约过期任务，事务提交后由调用方执行。"""
    timestamp = now or now_utc()
    candidates: list[tuple[datetime, JobKind, DataExportJob | DataImportJob]] = []
    job_types = [("export", DataExportJob, "queued")]
    if include_imports:
        job_types.append(("import", DataImportJob, "queued"))
    for kind, model, queued_status in job_types:
        claimable = [
            model.status == queued_status,
            (model.status == "running")
            & or_(model.lease_until.is_(None), model.lease_until <= timestamp),
        ]
        if kind == "import":
            claimable.extend([
                (model.status == "applying")
                & or_(model.lease_until.is_(None), model.lease_until <= timestamp),
            ])
        result = await db.execute(
            select(model)
            .where(or_(*claimable))
            .order_by(model.created_at, model.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        row = result.scalar_one_or_none()
        if row is not None:
            candidates.append((row.created_at, kind, row))

    if not candidates:
        await db.commit()
        return None

    _, kind, row = min(candidates, key=lambda candidate: (candidate[0], str(candidate[2].id)))
    resume_replace = kind == "import" and row.mode == "replace" and row.status == "applying"
    row.status = "applying" if resume_replace else "running"
    row.lease_owner = worker_id
    row.lease_until = timestamp + timedelta(seconds=lease_seconds)
    row.started_at = row.started_at or timestamp
    row.updated_at = timestamp
    if row.stage is None:
        row.stage = "exporting" if kind == "export" else "validating"
    job = ClaimedJob(
        kind=kind,
        job_id=row.id,
        user_id=row.user_id,
        mode="export" if kind == "export" else row.mode,
        stage=row.stage,
    )
    await db.commit()
    return job


async def renew_lease(
    db: AsyncSession,
    kind: JobKind,
    job_id: UUID,
    worker_id: str,
    *,
    now: datetime | None = None,
    lease_seconds: int = _LEASE_SECONDS,
) -> bool:
    """只允许当前租约持有者续租，避免旧 worker 覆写接管者状态。"""
    model = DataExportJob if kind == "export" else DataImportJob
    timestamp = now or now_utc()
    result = await db.execute(
        update(model)
        .where(
            model.id == job_id,
            model.status.in_({"running", "applying"}) if kind == "import" else model.status == "running",
            model.lease_owner == worker_id,
        )
        .values(lease_until=timestamp + timedelta(seconds=lease_seconds), updated_at=timestamp)
    )
    await db.commit()
    return result.rowcount == 1


async def release_for_retry(
    db: AsyncSession,
    kind: JobKind,
    job_id: UUID,
    worker_id: str,
    *,
    retry_stage: str,
    error_code: str,
    now: datetime | None = None,
) -> bool:
    """可重试失败回到队列；只保留脱敏错误码，不保存异常文本。"""
    model = DataExportJob if kind == "export" else DataImportJob
    timestamp = now or now_utc()
    result = await db.execute(
        update(model)
        .where(model.id == job_id, model.status == "running", model.lease_owner == worker_id)
        .values(
            status="queued",
            stage=retry_stage,
            error_code=error_code,
            lease_owner=None,
            lease_until=None,
            updated_at=timestamp,
        )
    )
    await db.commit()
    return result.rowcount == 1
