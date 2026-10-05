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
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import DataExportJob, DataImportJob, User
from app.services.data_portability import api_jobs
from app.services.data_portability.api_jobs import PortabilityJobError
from app.services.data_portability.crypto_stream import EncryptedArchiveWriter
from app.services.data_portability.crypto_stream import EncryptedArchiveReader
from app.services.data_portability.schema import PORTABLE_CATEGORIES
from app.services.storage import get_storage

router = APIRouter(prefix="/data-portability", tags=["data-portability"])
_EXPORT_TTL = timedelta(hours=24)
_MAX_UPLOAD_BYTES = 5 * 1024**3
_DOWNLOAD_TICKET_TTL_SECONDS = 120
_DOWNLOAD_TICKET_COOKIE = "gugu_export_ticket"


def _raise_job_error(exc: PortabilityJobError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from None


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
    return await api_jobs.export_preview(db, user.id)


@router.post("/exports", status_code=202)
async def create_export(
    body: ExportCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    categories = body.categories
    if "archive_docs" in categories or not categories.issubset(PORTABLE_CATEGORIES):
        raise HTTPException(status_code=422, detail="导出类别无效")
    try:
        row = await api_jobs.create_export_job(
            db, user_id=user.id, categories=categories,
            idempotency_key=body.idempotency_key, expires_at=now_utc() + _EXPORT_TTL,
        )
    except PortabilityJobError as exc:
        _raise_job_error(exc)
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

    token = secrets.token_urlsafe(32)
    try:
        job = await api_jobs.begin_preflight_import(
            db, user_id=user.id,
            token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
            expires_at=now_utc() + _EXPORT_TTL,
        )
    except PortabilityJobError as exc:
        _raise_job_error(exc)

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
        job = await api_jobs.finish_preflight_upload(
            db, job_id=job.id, user_id=user.id, digest=digest.hexdigest(), staging_key=staging_key,
        )
    except Exception:
        await db.rollback()
        await get_storage().delete(staging_key)
        await api_jobs.mark_preflight_upload_failed(db, job_id=job.id, user_id=user.id)
        raise
    finally:
        encrypted.close()
    return _import_view(job, include_token=token)


@router.get("/imports")
async def list_imports(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await api_jobs.list_import_jobs(db, user.id)
    return [_import_view(row) for row in rows]


@router.get("/imports/{job_id}")
async def get_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await api_jobs.get_import_job(db, user.id, job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导入任务")
    return _import_view(row)


@router.post("/imports/{job_id}/resume")
async def resume_import(
    job_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """恢复当前用户预检任务的确认能力；令牌仅在此响应中返回。"""
    try:
        row, token = await api_jobs.resume_preflight_import(db, user_id=user.id, job_id=job_id)
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    response.headers["Cache-Control"] = "no-store"
    return _import_view(row, include_token=token)


@router.post("/imports/{job_id}/apply", status_code=202)
async def apply_import(
    job_id: UUID,
    body: ImportApply,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """确认一项只读预检结果并排队执行；令牌为上传响应中的一次性能力凭据。"""
    try:
        row = await api_jobs.apply_import_job(
            db, user_id=user.id, job_id=job_id, mode=body.mode,
            import_token=body.import_token, idempotency_key=body.idempotency_key,
        )
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    return _import_view(row)


@router.post("/imports/{job_id}/cancel")
async def cancel_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        row, staging_key = await api_jobs.cancel_import_job(db, user_id=user.id, job_id=job_id)
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    if staging_key:
        try:
            await get_storage().delete(staging_key)
        except Exception as exc:
            diag_log("data_portability.cancel_cleanup", exc)
    return _import_view(row)


@router.delete("/imports/{job_id}", status_code=204)
async def delete_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """删除已结束的失败/预检任务及其私有暂存，不删除已导入数据。"""
    try:
        row, storage_keys = await api_jobs.delete_import_job(db, user_id=user.id, job_id=job_id)
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    for key in storage_keys:
        try:
            await get_storage().delete(key)
        except Exception as exc:
            diag_log("data_portability.import_delete", exc)
            raise HTTPException(status_code=503, detail="导入暂存数据暂时无法删除，请稍后重试") from None
    await api_jobs.finish_delete_import_job(db, row)


@router.post("/imports/{job_id}/rollback", status_code=202)
async def rollback_import(
    job_id: UUID,
    body: ImportRollback,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """将成功替换前的快照作为新的受控替换任务应用。"""
    try:
        rollback_job = await api_jobs.create_rollback_job(
            db, user_id=user.id, job_id=job_id, idempotency_key=body.idempotency_key,
        )
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    return _import_view(rollback_job)


@router.post("/imports/{job_id}/recover", status_code=202)
async def recover_import(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """显式重试恢复未能自动完成的数据替换。"""
    try:
        row = await api_jobs.recover_import_job(db, user_id=user.id, job_id=job_id)
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    return _import_view(row)


@router.get("/exports/{job_id}")
async def get_export(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await api_jobs.get_export_job(db, user.id, job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="找不到此导出任务")
    return _job_view(row)


@router.get("/exports")
async def list_exports(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await api_jobs.list_export_jobs(db, user.id)
    return [_job_view(row) for row in rows]


@router.post("/exports/{job_id}/cancel")
async def cancel_export(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        row = await api_jobs.cancel_export_job(db, user_id=user.id, job_id=job_id)
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    return _job_view(row)


@router.delete("/exports/{job_id}", status_code=204)
async def delete_export(job_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """提前删除已结束导出及其私有归档；运行中的任务必须先取消。"""
    try:
        row = await api_jobs.delete_export_job(db, user_id=user.id, job_id=job_id)
    except PortabilityJobError as exc:
        _raise_job_error(exc)
    if row.artifact_key:
        try:
            await get_storage().delete(row.artifact_key)
        except Exception as exc:
            diag_log("data_portability.export_delete", exc)
            raise HTTPException(status_code=503, detail="导出归档暂时无法删除，请稍后重试") from None
    await api_jobs.finish_delete_export_job(db, row)


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
    row = await api_jobs.ready_export_job_id(db, user_id=user.id, job_id=job_id, now=now_utc())
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
    # 票据下载必须留在当前站点 origin 下；绝对地址可能受反向代理 Host 配置影响，
    # 在开发环境中会把浏览器带到它自己的 localhost:8000。
    return {"url": download_path}


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
    row = await api_jobs.get_downloadable_export(db, user_id=user_id, job_id=job_id, now=now_utc())
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
