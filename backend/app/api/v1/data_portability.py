"""个人数据导出任务 API。所有对象都从认证用户推导归属。"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import tempfile
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import ChatAttachment, DataExportJob, DataImportJob, File, User
from app.services.data_portability.crypto_stream import EncryptedArchiveWriter
from app.services.data_portability.crypto_stream import EncryptedArchiveReader
from app.services.data_portability.projection import (
    RECORD_SPECS, _pending_attachment_ids, count_owned_records, select_owned_records,
)
from app.services.data_portability.schema import PORTABLE_CATEGORIES
from app.services.storage import get_storage

router = APIRouter(prefix="/data-portability", tags=["data-portability"])
_EXPORT_TTL = timedelta(hours=24)
_ACTIVE_STATUSES = {"queued", "running", "canceling"}
_ACTIVE_IMPORT_STATUSES = {"uploading", "queued", "running", "applying", "rolling_back", "needs_recovery"}
_MAX_UPLOAD_BYTES = 5 * 1024**3
_DOWNLOAD_TICKET_TTL_SECONDS = 120
_DOWNLOAD_TICKET_COOKIE = "gugu_export_ticket"


class ExportCreate(BaseModel):
    categories: set[str] = Field(min_length=1)
    idempotency_key: str = Field(min_length=8, max_length=128)


class ImportApply(BaseModel):
    mode: str = Field(pattern=r"^(incremental|replace)$")
    import_token: str = Field(min_length=32, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=128)


class ImportRollback(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=128)


def _job_view(row: DataExportJob) -> dict:
    return {
        "id": str(row.id), "status": row.status, "stage": row.stage,
        "progress_current": row.progress_current, "progress_total": row.progress_total,
        "error_code": row.error_code, "artifact_size": row.artifact_size,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "download_available": row.status == "ready" and row.artifact_key is not None,
    }


def _import_view(row: DataImportJob, *, include_token: str | None = None) -> dict:
    result = {
        "id": str(row.id), "status": row.status, "stage": row.stage,
        "mode": row.mode, "progress_current": row.progress_current,
        "progress_total": row.progress_total, "error_code": row.error_code,
        "preview": row.preview, "created_at": row.created_at.isoformat() if row.created_at else None,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "rollback_expires_at": row.rollback_expires_at.isoformat() if row.rollback_expires_at else None,
    }
    if include_token is not None:
        result["import_token"] = include_token
    return result


@router.get("/export/preview")
async def export_preview(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    counts = await count_owned_records(db, user.id)
    grouped = {category: {"records": 0, "bytes": 0} for category in PORTABLE_CATEGORIES}
    for spec in RECORD_SPECS:
        grouped[spec.category]["records"] += counts.get(spec.record_type, 0)
    file_bytes = int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user.id,
    ))).scalar_one())
    # ChatAttachment.user_id 只表示上传用户；附件可能挂在别人的会话或已脱离草稿队列。
    # 复用导出查询的所有权边界，预览字节数不包含这些不可导出的对象。
    draft_ids = await _pending_attachment_ids(db, user.id)
    attachment_spec = next(spec for spec in RECORD_SPECS if spec.model is ChatAttachment)
    attachment_bytes = 0
    after_id = None
    while True:
        rows = (await db.execute(select_owned_records(
            attachment_spec, user.id, after_id=after_id, limit=500,
        ))).scalars().all()
        if not rows:
            break
        attachment_bytes += sum(
            int(row.size or 0) for row in rows
            if row.state != "draft" or row.attach_id in draft_ids
        )
        after_id = getattr(rows[-1], attachment_spec.id_field)
    grouped["files"]["bytes"] = file_bytes
    grouped["conversations"]["bytes"] = attachment_bytes
    grouped["account"]["records"] = 1
    return {"categories": grouped, "format_version": "1.0"}


@router.post("/exports", status_code=202)
async def create_export(
    body: ExportCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    categories = body.categories
    if "archive_docs" in categories or not categories.issubset(PORTABLE_CATEGORIES):
        raise HTTPException(status_code=422, detail="导出类别无效")
    # 同一用户行作为跨导入/导出入口的互斥锁，避免两个并发请求同时通过检查。
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    existing = (await db.execute(select(DataExportJob).where(
        DataExportJob.user_id == user.id,
        DataExportJob.idempotency_key == body.idempotency_key,
    ))).scalar_one_or_none()
    if existing is not None:
        if set((existing.options or {}).get("categories") or ()) != categories:
            raise HTTPException(status_code=409, detail="此幂等键已用于不同的导出范围")
        return _job_view(existing)
    active = (await db.execute(select(DataExportJob.id).where(
        DataExportJob.user_id == user.id,
        DataExportJob.status.in_(_ACTIVE_STATUSES),
    ).limit(1))).scalar_one_or_none()
    import_active = (await db.execute(select(DataImportJob.id).where(
        DataImportJob.user_id == user.id,
        DataImportJob.status.in_(_ACTIVE_IMPORT_STATUSES),
    ).limit(1))).scalar_one_or_none()
    if active is not None or import_active is not None:
        raise HTTPException(status_code=409, detail="已有数据迁移任务正在处理")
    row = DataExportJob(
        user_id=user.id,
        status="queued",
        stage="queued",
        options={"categories": sorted(categories)},
        idempotency_key=body.idempotency_key,
        expires_at=now_utc() + _EXPORT_TTL,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _job_view(row)


@router.post("/imports/preflight", status_code=202)
async def preflight_import(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """以原始 ZIP 流上传；暂存使用服务端 envelope 加密，预检由 worker 异步执行。"""
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in {"application/zip", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="请选择 ZIP 格式的 Gugu 数据归档")
    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > _MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="上传归档超过大小限制")
        except ValueError:
            raise HTTPException(status_code=400, detail="上传长度无效") from None

    # 与导出创建共用同一用户行锁，阻止导出快照和上传阶段交错开始。
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    export_active = (await db.execute(select(DataExportJob.id).where(
        DataExportJob.user_id == user.id,
        DataExportJob.status.in_(_ACTIVE_STATUSES),
    ).limit(1))).scalar_one_or_none()
    import_active = (await db.execute(select(DataImportJob.id).where(
        DataImportJob.user_id == user.id,
        DataImportJob.status.in_(_ACTIVE_IMPORT_STATUSES),
    ).limit(1))).scalar_one_or_none()
    if export_active is not None or import_active is not None:
        raise HTTPException(status_code=409, detail="已有数据迁移任务正在处理")

    job = DataImportJob(
        user_id=user.id, mode="preflight", status="uploading", stage="uploading",
        expires_at=now_utc() + _EXPORT_TTL,
    )
    token = secrets.token_urlsafe(32)
    job.import_token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    db.add(job)
    await db.commit()
    await db.refresh(job)

    staging_key = f"{user.id.hex}/.data-portability/imports/{job.id.hex}.gupi"
    encrypted = tempfile.TemporaryFile(mode="w+b")
    envelope = EncryptedArchiveWriter(
        encrypted, f"data-portability-staging:{user.id.hex}:{job.id.hex}"
    )
    digest = hashlib.sha256()
    size = 0
    try:
        async for chunk in request.stream():
            size += len(chunk)
            if size > _MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="上传归档超过大小限制")
            digest.update(chunk)
            envelope.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="上传归档为空")
        envelope.finish()
        encrypted.seek(0, os.SEEK_END)
        encrypted_size = encrypted.tell()
        encrypted.seek(0)
        await get_storage().put_stream(staging_key, encrypted, encrypted_size, "application/octet-stream")
        job = (await db.execute(select(DataImportJob).where(
            DataImportJob.id == job.id, DataImportJob.user_id == user.id,
        ))).scalar_one()
        job.archive_sha256 = digest.hexdigest()
        job.staging_key = staging_key
        job.status = "queued"
        job.stage = "queued"
        job.updated_at = now_utc()
        await db.commit()
    except Exception:
        await db.rollback()
        await get_storage().delete(staging_key)
        async with db.begin():
            failed = (await db.execute(select(DataImportJob).where(
                DataImportJob.id == job.id, DataImportJob.user_id == user.id,
            ))).scalar_one_or_none()
            if failed is not None:
                failed.status = "failed"
                failed.stage = "failed"
                failed.error_code = "upload_failed"
                failed.updated_at = now_utc()
        raise
    finally:
        encrypted.close()
    return _import_view(job, include_token=token)


@router.get("/imports")
async def list_imports(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(DataImportJob).where(
        DataImportJob.user_id == user.id,
    ).order_by(DataImportJob.created_at.desc()).limit(20))).scalars().all()
    return [_import_view(row) for row in rows]


@router.get("/imports/{job_id}")
async def get_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user.id,
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导入任务")
    return _import_view(row)


@router.post("/imports/{job_id}/apply", status_code=202)
async def apply_import(
    job_id: UUID,
    body: ImportApply,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """确认一项只读预检结果并排队执行；令牌为上传响应中的一次性能力凭据。"""
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    row = (await db.execute(select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user.id,
    ).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导入任务")
    if row.status == "queued" and row.idempotency_key == body.idempotency_key and row.mode == body.mode:
        return _import_view(row)
    if row.status != "preview_ready" or row.mode != "preflight" or (row.expires_at and row.expires_at <= now_utc()):
        raise HTTPException(status_code=409, detail="导入预检尚未完成或任务已提交")
    candidate = hashlib.sha256(body.import_token.encode("utf-8")).hexdigest()
    if not row.import_token_hash or not hmac.compare_digest(candidate, row.import_token_hash):
        raise HTTPException(status_code=403, detail="导入确认令牌无效或已过期")
    if body.mode == "replace" and not bool((row.preview or {}).get("complete")):
        raise HTTPException(status_code=422, detail="全量替换需要完整归档")
    if body.mode == "incremental" and int(((row.preview or {}).get("conflicts") or {}).get("total") or 0):
        raise HTTPException(status_code=409, detail="归档中存在唯一键冲突，请先处理预检列出的冲突")
    export_active = (await db.execute(select(DataExportJob.id).where(
        DataExportJob.user_id == user.id, DataExportJob.status.in_(_ACTIVE_STATUSES),
    ).limit(1))).scalar_one_or_none()
    other_import = (await db.execute(select(DataImportJob.id).where(
        DataImportJob.user_id == user.id, DataImportJob.id != job_id,
        DataImportJob.status.in_(_ACTIVE_IMPORT_STATUSES),
    ).limit(1))).scalar_one_or_none()
    if export_active is not None or other_import is not None:
        raise HTTPException(status_code=409, detail="已有数据迁移任务正在处理")
    row.mode = body.mode
    row.status = "queued"
    row.stage = "queued"
    row.idempotency_key = body.idempotency_key
    row.import_token_hash = None
    row.updated_at = now_utc()
    await db.commit()
    await db.refresh(row)
    return _import_view(row)


@router.post("/imports/{job_id}/cancel")
async def cancel_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user.id,
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导入任务")
    if row.status != "queued":
        raise HTTPException(status_code=409, detail="此导入任务当前不能取消")
    staging_key = row.staging_key
    row.status = "canceled"
    row.stage = "canceled"
    row.import_token_hash = None
    row.finished_at = now_utc()
    row.updated_at = now_utc()
    await db.commit()
    if staging_key:
        try:
            await get_storage().delete(staging_key)
        except Exception as exc:
            diag_log("data_portability.cancel_cleanup", exc)
    await db.refresh(row)
    return _import_view(row)


@router.post("/imports/{job_id}/rollback", status_code=202)
async def rollback_import(
    job_id: UUID,
    body: ImportRollback,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """将成功替换前的快照作为新的受控替换任务应用。"""
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    source = (await db.execute(select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user.id,
    ).with_for_update())).scalar_one_or_none()
    if source is None:
        raise HTTPException(status_code=404, detail="找不到此导入任务")
    existing = (await db.execute(select(DataImportJob).where(
        DataImportJob.user_id == user.id,
        DataImportJob.idempotency_key == body.idempotency_key,
    ))).scalar_one_or_none()
    if existing is not None:
        if existing.mode != "rollback" or existing.source_job_id != source.id:
            raise HTTPException(status_code=409, detail="此幂等键已用于其他操作")
        return _import_view(existing)
    if (source.mode != "replace" or source.status != "completed" or not source.rollback_key
            or source.rollback_expires_at is None or source.rollback_expires_at <= now_utc()):
        raise HTTPException(status_code=409, detail="替换快照不存在或已过期")
    export_active = await db.scalar(select(DataExportJob.id).where(
        DataExportJob.user_id == user.id,
        DataExportJob.status.in_(_ACTIVE_STATUSES),
    ).limit(1))
    if await db.scalar(select(DataImportJob.id).where(
        DataImportJob.user_id == user.id,
        DataImportJob.status.in_(_ACTIVE_IMPORT_STATUSES),
    ).limit(1)):
        raise HTTPException(status_code=409, detail="已有数据迁移任务正在处理")
    if export_active is not None:
        raise HTTPException(status_code=409, detail="已有数据迁移任务正在处理")
    rollback_job = DataImportJob(
        user_id=user.id, mode="rollback", status="queued", stage="queued",
        source_job_id=source.id, idempotency_key=body.idempotency_key,
        archive_origin_id=source.archive_origin_id, archive_export_id=source.archive_export_id,
        preview={"complete": True, "rollback_of": str(source.id)},
        expires_at=source.rollback_expires_at,
    )
    db.add(rollback_job)
    await db.commit()
    await db.refresh(rollback_job)
    return _import_view(rollback_job)


@router.post("/imports/{job_id}/recover", status_code=202)
async def recover_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """显式重试恢复未能自动完成的数据替换。"""
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    row = (await db.execute(select(DataImportJob).where(
        DataImportJob.id == job_id, DataImportJob.user_id == user.id,
    ).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导入任务")
    if row.mode not in {"replace", "rollback"} or row.status != "needs_recovery" or not row.staging_key or not row.rollback_key:
        raise HTTPException(status_code=409, detail="此任务当前不需要恢复或恢复数据不完整")
    row.status = "queued"
    row.stage = "needs_recovery"
    row.lease_owner = None
    row.lease_until = None
    row.error_code = None
    row.updated_at = now_utc()
    await db.commit()
    await db.refresh(row)
    return _import_view(row)


@router.get("/exports/{job_id}")
async def get_export(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(DataExportJob).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user.id,
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导出任务")
    return _job_view(row)


@router.get("/exports")
async def list_exports(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(DataExportJob).where(
        DataExportJob.user_id == user.id,
    ).order_by(DataExportJob.created_at.desc()).limit(10))).scalars().all()
    return [_job_view(row) for row in rows]


@router.post("/exports/{job_id}/cancel")
async def cancel_export(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(DataExportJob).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user.id,
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导出任务")
    if row.status == "queued":
        row.status = "canceled"
        row.stage = "canceled"
        row.finished_at = now_utc()
        row.updated_at = now_utc()
    elif row.status == "running":
        row.status = "canceling"
        row.stage = "canceling"
        row.updated_at = now_utc()
    else:
        raise HTTPException(status_code=409, detail="此任务当前不能取消")
    await db.commit()
    await db.refresh(row)
    return _job_view(row)


@router.delete("/exports/{job_id}", status_code=204)
async def delete_export(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """提前删除已结束导出及其私有归档；运行中的任务必须先取消。"""
    row = (await db.execute(select(DataExportJob).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user.id,
    ).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导出任务")
    if row.status in _ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="请先取消仍在运行的导出任务")
    if row.artifact_key:
        try:
            await get_storage().delete(row.artifact_key)
        except Exception as exc:
            diag_log("data_portability.export_delete", exc)
            raise HTTPException(status_code=503, detail="导出归档暂时无法删除，请稍后重试") from None
    await db.delete(row)
    await db.commit()


def _download_ticket(user_id: UUID, job_id: UUID, expires_at: int) -> str:
    from app.core.config import get_settings

    payload = f"{user_id.hex}:{job_id.hex}:{expires_at}"
    signature = hmac.new(
        get_settings().secret_key.encode("utf-8"), payload.encode("ascii"), hashlib.sha256,
    ).hexdigest()
    return f"{payload}:{signature}"


def _verify_download_ticket(ticket: str | None, job_id: UUID) -> UUID | None:
    from app.core.config import get_settings
    import time

    if not ticket:
        return None
    try:
        user_hex, job_hex, expiry_text, signature = ticket.split(":", 3)
        user_id = UUID(hex=user_hex)
        ticket_job_id = UUID(hex=job_hex)
        expires_at = int(expiry_text)
        payload = f"{user_id.hex}:{ticket_job_id.hex}:{expires_at}"
        expected = hmac.new(
            get_settings().secret_key.encode("utf-8"), payload.encode("ascii"), hashlib.sha256,
        ).hexdigest()
        if (ticket_job_id != job_id or expires_at < int(time.time())
                or not hmac.compare_digest(signature, expected)):
            return None
        return user_id
    except (ValueError, UnicodeError):
        return None


@router.post("/exports/{job_id}/download-ticket")
async def create_browser_download_ticket(
    job_id: UUID,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """给浏览器原生下载签发短时、限路径的 HttpOnly cookie，避免前端缓冲整个大归档。"""
    row = (await db.execute(select(DataExportJob.id).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user.id,
        DataExportJob.status == "ready", DataExportJob.expires_at > now_utc(),
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="导出文件不存在或已过期")
    import time
    expiry = int(time.time()) + _DOWNLOAD_TICKET_TTL_SECONDS
    ticket = _download_ticket(user.id, job_id, expiry)
    download_path = f"{request.url.path.removesuffix('/download-ticket')}/download/browser"
    response.set_cookie(
        _DOWNLOAD_TICKET_COOKIE, ticket,
        max_age=_DOWNLOAD_TICKET_TTL_SECONDS,
        path=download_path,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
    )
    return {"url": str(request.base_url).rstrip("/") + download_path}


@router.get("/exports/{job_id}/download")
async def download_export(
    job_id: UUID,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _stream_export(job_id, user.id, request, db)


@router.get("/exports/{job_id}/download/browser", name="download_export_browser")
async def download_export_browser(job_id: UUID, request: Request, db: AsyncSession = Depends(get_db)):
    user_id = _verify_download_ticket(request.cookies.get(_DOWNLOAD_TICKET_COOKIE), job_id)
    if user_id is None:
        raise HTTPException(status_code=401, detail="下载授权已过期，请重新下载")
    return await _stream_export(job_id, user_id, request, db)


async def _stream_export(job_id: UUID, user_id: UUID, request: Request, db: AsyncSession):
    row = (await db.execute(select(DataExportJob).where(
        DataExportJob.id == job_id, DataExportJob.user_id == user_id,
        DataExportJob.status == "ready", DataExportJob.expires_at > now_utc(),
    ))).scalar_one_or_none()
    if row is None or not row.artifact_key:
        raise HTTPException(status_code=404, detail="导出文件不存在或已过期")

    source = tempfile.TemporaryFile(mode="w+b")
    digest = hashlib.sha256()
    size = 0
    try:
        async for chunk in get_storage().iter_chunks(row.artifact_key):
            source.write(chunk)
            digest.update(chunk)
            size += len(chunk)
        if size != row.artifact_size or digest.hexdigest() != row.artifact_sha256:
            raise HTTPException(status_code=410, detail="导出文件校验失败")
        context = f"data-portability:{user_id.hex}:{row.id.hex}"
        archive = EncryptedArchiveReader(source, context)
    except HTTPException:
        source.close()
        raise
    except Exception:
        source.close()
        raise HTTPException(status_code=410, detail="导出文件无法解密") from None

    total = archive.plaintext_size
    start, end = 0, total - 1
    status_code = 200
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Disposition": f'attachment; filename="gugu-export-{row.id.hex[:12]}.zip"',
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff",
    }
    range_header = request.headers.get("range")
    if range_header:
        try:
            unit, value = range_header.split("=", 1)
            first, last = value.split("-", 1)
            if unit != "bytes" or (not first and not last):
                raise ValueError
            if not first:
                suffix_length = int(last)
                if suffix_length <= 0:
                    raise ValueError
                start = max(total - suffix_length, 0)
                end = total - 1
            else:
                start = int(first)
                end = min(int(last), total - 1) if last else total - 1
            if start < 0 or start >= total or end < start:
                raise ValueError
            status_code = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        except ValueError:
            source.close()
            raise HTTPException(status_code=416, detail="下载范围无效", headers={"Content-Range": f"bytes */{total}"}) from None
    content_length = max(0, end - start + 1)
    headers["Content-Length"] = str(content_length)

    async def body():
        try:
            archive.seek(start)
            remaining = content_length
            while remaining:
                chunk = archive.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            source.close()

    return StreamingResponse(body(), status_code=status_code, headers=headers, media_type="application/zip")
