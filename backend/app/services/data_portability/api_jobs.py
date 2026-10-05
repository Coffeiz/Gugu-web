"""HTTP 可移植归档流程使用的任务持久化服务。"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import (
    ChatAttachment, DataExportJob, DataImportJob, File, User,
)
from app.services.data_portability.projection import (
    RECORD_SPECS, _pending_attachment_ids, count_owned_records, select_owned_records,
)
from app.services.data_portability.schema import PORTABLE_CATEGORIES

ACTIVE_EXPORT_STATUSES = {"queued", "running", "canceling"}
ACTIVE_IMPORT_STATUSES = {"uploading", "queued", "running", "applying", "rolling_back", "needs_recovery"}


class PortabilityJobError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def export_preview(db: AsyncSession, user_id: UUID) -> dict:
    counts = await count_owned_records(db, user_id)
    grouped = {category: {"records": 0, "bytes": 0} for category in PORTABLE_CATEGORIES}
    for spec in RECORD_SPECS:
        grouped[spec.category]["records"] += counts.get(spec.record_type, 0)
    grouped["files"]["bytes"] = int((await db.execute(select(
        func.coalesce(func.sum(File.size_bytes), 0)
    ).where(File.user_id == user_id))).scalar_one())

    # ChatAttachment.user_id 仅表示上传者；附件仍须符合导出投影中的归属条件。
    draft_ids = await _pending_attachment_ids(db, user_id)
    attachment_spec = next(spec for spec in RECORD_SPECS if spec.model is ChatAttachment)
    attachment_bytes = 0
    after_id = None
    while True:
        rows = (await db.execute(select_owned_records(
            attachment_spec, user_id, after_id=after_id, limit=500,
        ))).scalars().all()
        if not rows:
            break
        attachment_bytes += sum(
            int(row.size or 0) for row in rows
            if row.state != "draft" or row.attach_id in draft_ids
        )
        after_id = getattr(rows[-1], attachment_spec.id_field)
    grouped["conversations"]["bytes"] = attachment_bytes
    grouped["account"]["records"] = 1
    return {"categories": grouped, "format_version": "1.0"}


async def _lock_user(db: AsyncSession, user_id: UUID) -> None:
    await db.execute(select(User.id).where(User.id == user_id).with_for_update())


async def _has_active_export(db: AsyncSession, user_id: UUID) -> bool:
    return (await db.scalar(select(DataExportJob.id).where(
        DataExportJob.user_id == user_id,
        DataExportJob.status.in_(ACTIVE_EXPORT_STATUSES),
    ).limit(1))) is not None


async def _has_active_import(db: AsyncSession, user_id: UUID, *, exclude_id: UUID | None = None) -> bool:
    query = select(DataImportJob.id).where(
        DataImportJob.user_id == user_id,
        DataImportJob.status.in_(ACTIVE_IMPORT_STATUSES),
    )
    if exclude_id is not None:
        query = query.where(DataImportJob.id != exclude_id)
    return (await db.scalar(query.limit(1))) is not None


async def create_export_job(
    db: AsyncSession, *, user_id: UUID, categories: set[str], idempotency_key: str,
    expires_at: datetime,
) -> DataExportJob:
    await _lock_user(db, user_id)
    existing = (await db.execute(select(DataExportJob).where(
        DataExportJob.user_id == user_id,
        DataExportJob.idempotency_key == idempotency_key,
    ))).scalar_one_or_none()
    if existing is not None:
        if set((existing.options or {}).get("categories") or ()) != categories:
            raise PortabilityJobError(409, "此幂等键已用于不同的导出范围")
        return existing
    if await _has_active_export(db, user_id) or await _has_active_import(db, user_id):
        raise PortabilityJobError(409, "已有数据迁移任务正在处理")
    row = DataExportJob(
        user_id=user_id, status="queued", stage="queued",
        options={"categories": sorted(categories)}, idempotency_key=idempotency_key,
        expires_at=expires_at,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def begin_preflight_import(
    db: AsyncSession, *, user_id: UUID, token_hash: str, expires_at: datetime,
) -> DataImportJob:
    await _lock_user(db, user_id)
    if await _has_active_export(db, user_id) or await _has_active_import(db, user_id):
        raise PortabilityJobError(409, "已有数据迁移任务正在处理")
    row = DataImportJob(
        user_id=user_id, mode="preflight", status="uploading", stage="uploading",
        expires_at=expires_at, import_token_hash=token_hash,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def finish_preflight_upload(
    db: AsyncSession, *, job_id: UUID, user_id: UUID, digest: str, staging_key: str,
) -> DataImportJob:
    row = (await db.execute(select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user_id,
    ).with_for_update())).scalar_one()
    if row.status != "uploading":
        raise PortabilityJobError(409, "上传任务已结束，不能继续完成预检")
    if row.expires_at is not None and row.expires_at <= now_utc():
        row.status = row.stage = "expired"
        row.import_token_hash = None
        row.finished_at = row.updated_at = now_utc()
        await db.commit()
        raise PortabilityJobError(409, "上传任务已过期，请重新上传归档")
    row.archive_sha256 = digest
    row.staging_key = staging_key
    row.status = row.stage = "queued"
    row.updated_at = now_utc()
    await db.commit()
    return row


async def mark_preflight_upload_failed(db: AsyncSession, *, job_id: UUID, user_id: UUID) -> None:
    async with db.begin():
        row = (await db.execute(select(DataImportJob).where(
            DataImportJob.id == job_id, DataImportJob.user_id == user_id,
        ))).scalar_one_or_none()
        if row is not None:
            if row.status != "uploading":
                return
            row.status = row.stage = "failed"
            row.error_code = "upload_failed"
            row.import_token_hash = None
            row.finished_at = now_utc()
            row.updated_at = now_utc()


async def get_import_job(db: AsyncSession, user_id: UUID, job_id: UUID, *, lock: bool = False) -> DataImportJob | None:
    query = select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user_id,
    )
    if lock:
        query = query.with_for_update()
    return (await db.execute(query)).scalar_one_or_none()


async def resume_preflight_import(
    db: AsyncSession, *, user_id: UUID, job_id: UUID,
) -> tuple[DataImportJob, str]:
    """为当前用户尚未提交的预检任务轮换一次性确认令牌。"""
    row = await get_import_job(db, user_id, job_id, lock=True)
    if row is None:
        raise PortabilityJobError(404, "找不到此导入任务")
    if (row.mode != "preflight" or row.status != "preview_ready" or not row.staging_key
            or not row.preview or row.expires_at is None or row.expires_at <= now_utc()):
        raise PortabilityJobError(409, "此预检任务已过期或不能继续")

    token = secrets.token_urlsafe(32)
    row.import_token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    row.updated_at = now_utc()
    await db.commit()
    await db.refresh(row)
    return row, token


async def list_import_jobs(db: AsyncSession, user_id: UUID) -> list[DataImportJob]:
    return (await db.execute(select(DataImportJob).where(
        DataImportJob.user_id == user_id,
    ).order_by(DataImportJob.created_at.desc()).limit(20))).scalars().all()


async def apply_import_job(
    db: AsyncSession, *, user_id: UUID, job_id: UUID, mode: str,
    import_token: str, idempotency_key: str,
) -> DataImportJob:
    await _lock_user(db, user_id)
    row = await get_import_job(db, user_id, job_id, lock=True)
    if row is None:
        raise PortabilityJobError(404, "找不到此导入任务")
    if row.status == "queued" and row.idempotency_key == idempotency_key and row.mode == mode:
        return row
    if row.status != "preview_ready" or row.mode != "preflight" or (row.expires_at and row.expires_at <= now_utc()):
        raise PortabilityJobError(409, "导入预检尚未完成或任务已提交")
    candidate = hashlib.sha256(import_token.encode("utf-8")).hexdigest()
    if not row.import_token_hash or not hmac.compare_digest(candidate, row.import_token_hash):
        raise PortabilityJobError(403, "导入确认令牌无效或已过期")
    if mode == "replace" and not bool((row.preview or {}).get("complete")):
        raise PortabilityJobError(422, "全量替换需要完整归档")
    if mode == "incremental" and int(((row.preview or {}).get("conflicts") or {}).get("total") or 0):
        raise PortabilityJobError(409, "归档中存在唯一键冲突，请先处理预检列出的冲突")
    if await _has_active_export(db, user_id) or await _has_active_import(db, user_id, exclude_id=job_id):
        raise PortabilityJobError(409, "已有数据迁移任务正在处理")
    row.mode = mode
    row.status = row.stage = "queued"
    row.idempotency_key = idempotency_key
    row.import_token_hash = None
    row.updated_at = now_utc()
    await db.commit()
    await db.refresh(row)
    return row


async def cancel_import_job(db: AsyncSession, *, user_id: UUID, job_id: UUID) -> tuple[DataImportJob, str | None]:
    row = await get_import_job(db, user_id, job_id)
    if row is None:
        raise PortabilityJobError(404, "找不到此导入任务")
    if row.status != "queued":
        raise PortabilityJobError(409, "此导入任务当前不能取消")
    staging_key = row.staging_key
    row.status = row.stage = "canceled"
    row.import_token_hash = None
    row.finished_at = row.updated_at = now_utc()
    await db.commit()
    await db.refresh(row)
    return row, staging_key


async def delete_import_job(
    db: AsyncSession, *, user_id: UUID, job_id: UUID,
) -> tuple[DataImportJob, tuple[str, ...]]:
    """只删除可安全丢弃的预检/失败任务，不触碰已导入业务数据。"""
    row = await get_import_job(db, user_id, job_id, lock=True)
    if row is None:
        raise PortabilityJobError(404, "找不到此导入任务")
    if row.status not in {"preview_ready", "failed", "canceled", "expired"}:
        raise PortabilityJobError(409, "此导入任务当前不能删除")
    storage_keys = tuple(dict.fromkeys(key for key in (row.staging_key, row.rollback_key) if key))
    return row, storage_keys


async def finish_delete_import_job(db: AsyncSession, row: DataImportJob) -> None:
    await db.delete(row)
    await db.commit()


async def create_rollback_job(
    db: AsyncSession, *, user_id: UUID, job_id: UUID, idempotency_key: str,
) -> DataImportJob:
    await _lock_user(db, user_id)
    source = await get_import_job(db, user_id, job_id, lock=True)
    if source is None:
        raise PortabilityJobError(404, "找不到此导入任务")
    existing = (await db.execute(select(DataImportJob).where(
        DataImportJob.user_id == user_id,
        DataImportJob.idempotency_key == idempotency_key,
    ))).scalar_one_or_none()
    if existing is not None:
        if existing.mode != "rollback" or existing.source_job_id != source.id:
            raise PortabilityJobError(409, "此幂等键已用于其他操作")
        return existing
    timestamp = now_utc()
    if (source.mode != "replace" or source.status != "completed" or not source.rollback_key
            or source.rollback_expires_at is None or source.rollback_expires_at <= timestamp):
        raise PortabilityJobError(409, "替换快照不存在或已过期")
    if await _has_active_export(db, user_id) or await _has_active_import(db, user_id):
        raise PortabilityJobError(409, "已有数据迁移任务正在处理")
    row = DataImportJob(
        user_id=user_id, mode="rollback", status="queued", stage="queued",
        source_job_id=source.id, idempotency_key=idempotency_key,
        archive_origin_id=source.archive_origin_id, archive_export_id=source.archive_export_id,
        preview={"complete": True, "rollback_of": str(source.id)},
        expires_at=source.rollback_expires_at,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def recover_import_job(db: AsyncSession, *, user_id: UUID, job_id: UUID) -> DataImportJob:
    await _lock_user(db, user_id)
    row = await get_import_job(db, user_id, job_id, lock=True)
    if row is None:
        raise PortabilityJobError(404, "找不到此导入任务")
    if row.mode not in {"replace", "rollback"} or row.status != "needs_recovery" or not row.staging_key or not row.rollback_key:
        raise PortabilityJobError(409, "此任务当前不需要恢复或恢复数据不完整")
    row.status = "queued"
    row.stage = "needs_recovery"
    row.lease_owner = row.lease_until = None
    row.error_code = None
    row.updated_at = now_utc()
    await db.commit()
    await db.refresh(row)
    return row


async def get_export_job(db: AsyncSession, user_id: UUID, job_id: UUID, *, lock: bool = False) -> DataExportJob | None:
    query = select(DataExportJob).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user_id,
    )
    if lock:
        query = query.with_for_update()
    return (await db.execute(query)).scalar_one_or_none()


async def list_export_jobs(db: AsyncSession, user_id: UUID) -> list[DataExportJob]:
    return (await db.execute(select(DataExportJob).where(
        DataExportJob.user_id == user_id,
    ).order_by(DataExportJob.created_at.desc()).limit(10))).scalars().all()


async def cancel_export_job(db: AsyncSession, *, user_id: UUID, job_id: UUID) -> DataExportJob:
    row = await get_export_job(db, user_id, job_id, lock=True)
    if row is None:
        raise PortabilityJobError(404, "找不到此导出任务")
    timestamp = now_utc()
    if row.status == "queued":
        row.status = row.stage = "canceled"
        row.finished_at = timestamp
        row.updated_at = timestamp
    elif row.status == "running":
        row.status = row.stage = "canceling"
        row.updated_at = timestamp
    else:
        raise PortabilityJobError(409, "此任务当前不能取消")
    await db.commit()
    await db.refresh(row)
    return row


async def delete_export_job(db: AsyncSession, *, user_id: UUID, job_id: UUID) -> DataExportJob:
    row = await get_export_job(db, user_id, job_id, lock=True)
    if row is None:
        raise PortabilityJobError(404, "找不到此导出任务")
    if row.status in ACTIVE_EXPORT_STATUSES:
        raise PortabilityJobError(409, "请先取消仍在运行的导出任务")
    return row


async def finish_delete_export_job(db: AsyncSession, row: DataExportJob) -> None:
    await db.delete(row)
    await db.commit()


async def ready_export_job_id(db: AsyncSession, *, user_id: UUID, job_id: UUID, now: datetime) -> UUID | None:
    return await db.scalar(select(DataExportJob.id).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user_id,
        DataExportJob.status == "ready", DataExportJob.expires_at > now,
    ))


async def get_downloadable_export(db: AsyncSession, *, user_id: UUID, job_id: UUID, now: datetime) -> DataExportJob | None:
    return (await db.execute(select(DataExportJob).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user_id,
        DataExportJob.status == "ready", DataExportJob.expires_at > now,
    ))).scalar_one_or_none()
