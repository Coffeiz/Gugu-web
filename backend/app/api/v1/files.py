import asyncio
from app.core.tz import now_utc
import os
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, UploadFile, File as FastAPIFile, Form
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Folder, Project, User
from app.schemas import FileResponse, FileUpdate, FileTreeResponse, ProjectTreeEntry, BatchDeleteBody, FileCopyBody, BatchDownloadBody
from jose import jwt, JWTError
from app.core.security import get_current_user, get_client_id, create_stream_token, verify_stream_token
from app.core.ownership import get_owned
from app.core.config import get_settings
from app.core import events
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.storage.file_service.files import _fmt_size
from app.services.files.response import color_value, to_file_response
from app.services.files.browser import all_files_query, file_listing_query, storage_usage_query
from app.services.files.upload import (
    UploadTargetError,
    confirm_oss_upload,
    find_conflict,
    parse_upload_filename,
    prepare_presign_target,
)
from app.services.files.selection import build_batch_zip, move_file_to_trash_by_id, move_files_to_trash
from app.services.files.previews import (
    delete_thumb_cache,
    office_to_pdf,
    pregenerate_thumb,
    render_thumbnail,
)

router = APIRouter(prefix="/files", tags=["files"])

_OFFICE_EXTS = frozenset({'DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX'})
_pdf_cache: dict[str, bytes] = {}   # key: "{fid}:{updated_at_iso}"

# 单文件上传硬上限（字节）——独立于存储配额，防一次性 read 进内存打爆。
_MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# ── GET /files ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[FileResponse])
async def list_files(
    space: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_id: Optional[int] = None,
    mind_map_id: Optional[int] = None,
    ext: Optional[str] = None,
    q: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = file_listing_query(
        current_user.id,
        space=space,
        project_id=project_id,
        folder_id=folder_id,
        mind_map_id=mind_map_id,
        ext=ext,
        query=q,
    )

    result = await db.execute(stmt)
    return [to_file_response(f, pname, color_value(pcolor), fname) for f, pname, pcolor, fname in result.all()]


# ── GET /files/all ────────────────────────────────────────────────────────────

@router.get("/all", response_model=list[FileResponse])
async def list_all_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = all_files_query(current_user.id)
    result = await db.execute(stmt)
    rows = result.all()

    # 本地存储时过滤掉实体文件已被手动删除的记录，并同步软删除数据库条目
    storage = get_storage()
    from app.services.storage import LocalStorageBackend
    if isinstance(storage, LocalStorageBackend):
        now = now_utc()
        valid_rows = []
        for row in rows:
            f, pname, pcolor, fname = row
            if (storage.root / f.storage_key).exists():
                valid_rows.append(row)
            else:
                await db.delete(f)
        if len(valid_rows) < len(rows):
            await db.commit()
        rows = valid_rows

    return [to_file_response(f, pname, color_value(pcolor), fname) for f, pname, pcolor, fname in rows]


# ── GET /files/version ────────────────────────────────────────────────────────

@router.get("/version")
async def files_version(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回文件表状态摘要，用于前端感知服务端变更（删除/修改均会改变结果）。"""
    stmt = (
        select(
            func.count(File.id),
            func.max(File.updated_at),
            func.max(File.deleted_at),
        )
        .where(File.user_id == current_user.id)
    )
    result = await db.execute(stmt)
    count, max_updated, max_deleted = result.one()
    version = f"{count}:{max_updated}:{max_deleted}"
    return {"version": version}


# ── GET /files/storage ───────────────────────────────────────────────────────

@router.get("/storage")
async def files_storage(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户的存储用量与上限。"""
    used_res = await db.execute(
        storage_usage_query(current_user.id)
    )
    used = used_res.scalar() or 0
    limit = current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes
    return {"used_bytes": used, "limit_bytes": limit}


# ── GET /files/tree ───────────────────────────────────────────────────────────

@router.get("/tree", response_model=FileTreeResponse)
async def file_tree(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id

    # 项目文件数汇总
    proj_rows = await db.execute(
        select(File.project_id, func.count().label("cnt"))
        .where(File.user_id == uid, File.space == "project",
               File.project_id.isnot(None), File.deleted_at.is_(None))
        .group_by(File.project_id)
    )
    count_map = {pid: cnt for pid, cnt in proj_rows.all()}

    projs_res = await db.execute(
        select(Project).where(Project.user_id == uid).order_by(Project.created_at.desc())
    )
    projects = projs_res.scalars().all()

    tree_projects = [
        ProjectTreeEntry(id=p.id, name=p.name, color=color_value(p.color) or p.color,
                         total_count=count_map.get(p.id, 0))
        for p in projects
    ]

    personal_count = (await db.execute(
        select(func.count()).where(File.user_id == uid, File.space == "personal",
                                   File.deleted_at.is_(None))
    )).scalar_one()

    return FileTreeResponse(projects=tree_projects, personal_count=personal_count)


# ── POST /files/check-conflicts ─────────────────────────────────────────────
# 上传前批量探测同名冲突，前端拿到结果后一次性把所有冲突列给用户挑（覆盖/保留两者/跳过），
# 而不是每上传一个文件弹一次——不落库、不占用配额、纯查询。

from pydantic import BaseModel as _BaseModel


class ConflictCheckItem(_BaseModel):
    filename: str            # 含扩展名，如 "报告.pdf"
    space: str = "personal"
    project_id: Optional[int] = None
    folder_id: Optional[int] = None


class ConflictCheckRequest(_BaseModel):
    items: list[ConflictCheckItem]


@router.post("/check-conflicts")
async def check_conflicts(
    body: ConflictCheckRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    out = []
    for item in body.items:
        display_name, ext = parse_upload_filename(item.filename)
        existing = await find_conflict(db, current_user.id, item.space, item.project_id, item.folder_id, display_name, ext)
        out.append({
            "filename": item.filename,
            "conflict": existing is not None,
            "existing_file": to_file_response(existing).model_dump() if existing else None,
        })
    return out


# ── POST /files ───────────────────────────────────────────────────────────────

@router.post("", response_model=FileResponse, status_code=201)
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = FastAPIFile(...),
    space: str = Form("personal"),
    project_id: Optional[int] = Form(None),
    folder_id: Optional[int] = Form(None),
    stage_name: str = Form(""),
    mind_map_id: Optional[int] = Form(None),
    on_conflict: str = Form("keep_both"),          # keep_both（默认，同名自动加后缀）| overwrite
    overwrite_file_id: Optional[int] = Form(None),  # on_conflict=overwrite 时，目标文件 id
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    original_name = file.filename or "file"
    display_name, ext = parse_upload_filename(original_name)
    mime_type = file.content_type

    data = await file.read()
    size_bytes = len(data)

    # 单文件硬上限：整个请求体一次性进内存，配额可能为 None（无限），需独立的字节闸防内存打爆。
    # 属请求体传输约束（413），留在端点；语义校验（项目/文件夹/配额/覆盖）在 FileService。
    if size_bytes > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"文件过大（单文件上限 {_MAX_UPLOAD_BYTES // 1048576}MB）")

    _is_img = bool(mime_type) and mime_type.lower() in _IMAGE_MIMES and mime_type.lower() != "image/svg+xml"
    img_width, img_height = None, None
    if _is_img:
        try:
            from PIL import Image as _PILImage
            import io as _io
            _pil = _PILImage.open(_io.BytesIO(data))
            img_width, img_height = _pil.size
            _pil.close()
        except Exception:
            pass

    _storage_limit = current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes

    # 语义核心（key/配额/覆盖/落库）交 FileService；端点保留传输面：图片尺寸解出、缩略图调度、
    # 缓存清理、响应 shape、事务与事件。覆盖不发 files 事件（复刻原行为）。
    result = await FileService(db).create_file(
        current_user.id, space=space, project_id=project_id, folder_id=folder_id,
        stage_name=stage_name, mind_map_id=mind_map_id, display_name=display_name, ext=ext,
        mime_type=mime_type, data=data, img_width=img_width, img_height=img_height,
        on_conflict=on_conflict, overwrite_file_id=overwrite_file_id,
        storage_limit_bytes=_storage_limit,
    )
    f = result.file
    if result.was_overwrite:
        delete_thumb_cache(f.id)   # 旧缩略图必须清，否则还显示覆盖前的图

    await db.commit()
    await db.refresh(f)
    if not result.was_overwrite:
        await events.publish(current_user.id, "files", origin=origin)

    project_name = result.project.name if result.project else None
    project_color = color_value(result.project.color) if result.project else None
    resp = to_file_response(f, project_name, project_color, result.folder_name)
    if _is_img:
        background_tasks.add_task(pregenerate_thumb, f.storage_key, f.id)
    return resp


# ── POST /files/presign ───────────────────────────────────────────────────────

class PresignRequest(_BaseModel):
    filename: str
    size_bytes: int
    mime_type: str = "application/octet-stream"
    space: str = "personal"
    project_id: Optional[int] = None
    folder_id: Optional[int] = None
    stage_name: str = ""
    on_conflict: str = "keep_both"          # keep_both | overwrite
    overwrite_file_id: Optional[int] = None


@router.post("/presign")
async def presign_upload(
    body: PresignRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """检查存储后端：OSS 时签发 presigned PUT URL；本地时返回 {mode:'proxy'}。"""
    from app.services.storage import get_storage, OSSStorageBackend

    storage = get_storage()
    try:
        target = await prepare_presign_target(
            db,
            storage,
            current_user.id,
            body.filename,
            body.size_bytes,
            body.space,
            body.project_id,
            body.folder_id,
            body.on_conflict,
            body.overwrite_file_id,
            current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes,
        )
    except UploadTargetError as error:
        raise HTTPException(error.status_code, error.detail) from error

    if isinstance(storage, OSSStorageBackend):
        import asyncio as _asyncio
        upload_url = await _asyncio.to_thread(
            storage.presign_put, target.final_key, body.mime_type, 600
        )
        return {
            "mode": "oss",
            "upload_url": upload_url,
            "storage_key": target.final_key,
            "final_name": target.final_name,
            "ext": target.ext,
            "overwrite_file_id": target.overwrite_file_id,
        }

    return {"mode": "proxy"}


# ── POST /files/confirm ───────────────────────────────────────────────────────

class ConfirmRequest(_BaseModel):
    storage_key: str
    display_name: str
    ext: str
    mime_type: str = "application/octet-stream"
    size_bytes: int
    space: str = "personal"
    project_id: Optional[int] = None
    folder_id: Optional[int] = None
    stage_name: str = ""
    overwrite_file_id: Optional[int] = None   # presign 阶段返回的目标文件 id，覆盖时原地更新而非新建


@router.post("/confirm", response_model=FileResponse, status_code=201)
async def confirm_upload(
    body: ConfirmRequest,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    """OSS 直传完成后，注册 DB 记录（或覆盖已有文件时，原地更新那条记录）。"""
    from app.services.storage import get_storage, OSSStorageBackend

    if not body.storage_key.startswith(f"{current_user.id}/"):
        raise HTTPException(403, "无权限访问该存储路径")

    storage = get_storage()
    if not isinstance(storage, OSSStorageBackend):
        raise HTTPException(400, "当前存储后端不是 OSS，请使用普通上传")

    if not await storage.exists(body.storage_key):
        raise HTTPException(400, "文件尚未上传到 OSS，请先完成直传")

    try:
        result = await confirm_oss_upload(
            db,
            current_user.id,
            storage_key=body.storage_key,
            display_name=body.display_name,
            ext=body.ext,
            mime_type=body.mime_type,
            size_bytes=body.size_bytes,
            space=body.space,
            project_id=body.project_id,
            folder_id=body.folder_id,
            stage_name=body.stage_name,
            overwrite_file_id=body.overwrite_file_id,
        )
    except UploadTargetError as error:
        raise HTTPException(error.status_code, error.detail) from error

    if result.overwritten_file_id is not None:
        delete_thumb_cache(result.overwritten_file_id)
    await db.commit()
    await db.refresh(result.file)
    await events.publish(current_user.id, "files", origin=origin)

    project_color = color_value(result.project.color) if result.project else None
    return to_file_response(result.file, result.project.name if result.project else None,
                            project_color, result.folder_name)


# ── PATCH /files/{fid} ───────────────────────────────────────────────────────

@router.patch("/{fid}", response_model=FileResponse)
async def update_file(
    fid: int,
    body: FileUpdate,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    # folder_id/project_id 只在显式出现（含 null）时才更新——纯改名 patch 不带这两字段，
    # 不能被当成「移到个人空间」。key 重算/物理搬迁/落库交 FileService。
    result = await FileService(db).update_file(
        current_user.id, fid,
        display_name=body.display_name, stage_name=body.stage_name,
        folder_id=body.folder_id, project_id=body.project_id,
        folder_set='folder_id' in body.model_fields_set,
        project_set='project_id' in body.model_fields_set,
    )
    await db.commit()
    await db.refresh(result.file)
    await events.publish(current_user.id, "files", origin=origin)

    project_name = result.project.name if result.project else None
    project_color = color_value(result.project.color) if result.project else None
    return to_file_response(result.file, project_name, project_color, result.folder_name)


class _FileContentBody(_BaseModel):
    content: str


@router.put("/{fid}/content", response_model=FileResponse)
async def update_file_content(
    fid: int,
    body: _FileContentBody,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    """改文本文件正文（md 预览里点任务勾选框等场景，前端直接存）。仅文本类、限 1MB。"""
    from app.core.chat_attach import TEXT_EXTS
    f = await get_owned(db, File, fid, current_user.id)
    if not f:
        raise HTTPException(404, "文件不存在")
    if (f.ext or "").lower() not in TEXT_EXTS:
        raise HTTPException(400, "仅文本类文件可改内容")
    data = body.content.encode("utf-8")
    if len(data) > 1024 * 1024:
        raise HTTPException(400, "内容过大（上限 1MB）")
    await get_storage().put(f.storage_key, data, f.mime_type or "text/markdown")
    f.size_bytes = len(data)
    f.size = _fmt_size(len(data))
    f.updated_at = now_utc()
    await db.commit()
    await db.refresh(f)
    await events.publish(current_user.id, "files", origin=origin)
    return to_file_response(f)


# ── POST /files/{fid}/copy ────────────────────────────────────────────────────

@router.post("/{fid}/copy", response_model=FileResponse)
async def copy_file(
    fid: int,
    body: FileCopyBody,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    # 目标空间由调用方明确指定的 project_id 决定，不从源文件继承——否则「项目文件复制到个人
    # 文件库」这类跨空间粘贴会静默失败，复制出的文件还留在原项目里（两处前端调用都会显式带上
    # 目标 project_id，个人空间传 null）。物理拷贝 + key + 落库交 FileService。
    result = await FileService(db).copy_file(
        current_user.id, fid, folder_id=body.folder_id, project_id=body.project_id)
    await db.commit()
    await db.refresh(result.file)
    await events.publish(current_user.id, "files", origin=origin)

    project_name = result.project.name if result.project else None
    project_color = color_value(result.project.color) if result.project else None
    return to_file_response(result.file, project_name, project_color, result.folder_name)


# ── DELETE /files/{fid} （软删除→回收站）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    moved = await move_file_to_trash_by_id(
        db, get_storage(), current_user.id, fid, now_utc())
    if not moved:
        raise HTTPException(404, "文件不存在")
    await db.commit()
    await events.publish(current_user.id, "files", origin=origin,
                         file_op={"op": "remove", "kind": "file", "id": fid})


# ── POST /files/batch-delete ──────────────────────────────────────────────────

@router.post("/batch-delete", status_code=204)
async def batch_delete_files(
    body: BatchDeleteBody,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    if not body.ids:
        return
    file_ids = await move_files_to_trash(
        db, get_storage(), current_user.id, body.ids, now_utc())
    await db.commit()
    await events.publish(current_user.id, "files", origin=origin,
                         file_op={"op": "remove", "kind": "file", "ids": file_ids})


# ── POST /files/batch-download ───────────────────────────────────────────────

@router.post("/batch-download")
async def batch_download_files(
    body: BatchDownloadBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import Response

    try:
        data = await build_batch_zip(db, get_storage(), current_user.id, body.ids, body.folder_ids)
    except ValueError as error:
        raise HTTPException(400, str(error))
    except FileNotFoundError as error:
        raise HTTPException(404, str(error))
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''files.zip"},
    )


# ── GET /files/{fid}/thumb ────────────────────────────────────────────────────
# 供 <img src="..."> 使用，通过 query param 传 JWT（与 stream 端点一致）

_IMAGE_MIMES = frozenset({
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/avif', 'image/bmp', 'image/svg+xml', 'image/heic', 'image/heif',
})

@router.get("/{fid}/thumb")
async def get_thumb(
    request: Request,
    fid: int,
    size: str = Query("full"),   # "tiny" | "card" | "full"
    db: AsyncSession = Depends(get_db),
):
    import asyncio
    from fastapi.responses import Response as FastAPIResponse
    settings = get_settings()
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Token 无效")
    try:
        from uuid import UUID as _UUID
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") != "user":
            raise ValueError("not user")
        user_id = _UUID(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(401, "Token 无效")

    f = await get_owned(db, File, fid, user_id)
    if not f or f.deleted_at is not None:
        raise HTTPException(404, "文件不存在")

    mime = (f.mime_type or '').lower()
    if mime not in _IMAGE_MIMES:
        raise HTTPException(415, "不是图片文件")

    # SVG 和全尺寸直接返回原图
    if size == "full" or mime == "image/svg+xml":
        try:
            data = await get_storage().get(f.storage_key)
        except FileNotFoundError:
            raise HTTPException(404, "物理文件丢失")
        return FastAPIResponse(content=data, media_type=mime,
                               headers={"Cache-Control": "private, max-age=86400"})

    # 缓存 miss：读原图，按需生成请求的尺寸（card 不在上传时预生成）
    try:
        raw = await get_storage().get(f.storage_key)
    except FileNotFoundError:
        raise HTTPException(404, "物理文件丢失")
    content, media_type = await render_thumbnail(raw, fid, size, mime)
    return FastAPIResponse(content=content, media_type=media_type,
                           headers={"Cache-Control": "private, max-age=86400"})


# ── GET /files/{fid}/download ────────────────────────────────────────────────

@router.get("/{fid}/download")
async def download_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import Response
    from urllib.parse import quote

    f = await get_owned(db, File, fid, current_user.id)
    if not f:
        raise HTTPException(404, "文件不存在")
    data = await get_storage().get(f.storage_key)
    filename = quote(f"{f.display_name}.{f.ext.lower()}")
    return Response(
        content=data,
        media_type=f.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


# ── GET /files/{fid}/preview-pdf ─────────────────────────────────────────────

@router.get("/{fid}/preview-pdf")
async def preview_pdf(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import Response

    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at is not None:
        raise HTTPException(404, "文件不存在")
    if f.ext.upper() not in _OFFICE_EXTS:
        raise HTTPException(400, "不支持的格式")

    cache_key = f"{fid}:{f.updated_at.isoformat()}"
    if cache_key not in _pdf_cache:
        if len(_pdf_cache) > 50:
            _pdf_cache.clear()
        raw = await get_storage().get(f.storage_key)
        try:
            _pdf_cache[cache_key] = await office_to_pdf(raw, f.ext)
        except asyncio.TimeoutError:
            raise HTTPException(422, "文档转换超时")
        except RuntimeError as error:
            raise HTTPException(422, str(error))

    return Response(
        content=_pdf_cache[cache_key],
        media_type="application/pdf",
        headers={"Cache-Control": "private, max-age=300"},
    )


# ── GET /files/{fid}/stream-url ──────────────────────────────────────────────

@router.get("/{fid}/stream-url")
async def get_stream_url(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.core.config import get_settings

    f = await get_owned(db, File, fid, current_user.id)
    if not f:
        raise HTTPException(404, "文件不存在")

    storage = get_storage()
    from app.services.storage import OSSStorageBackend, LocalStorageBackend
    if isinstance(storage, OSSStorageBackend):
        import asyncio
        url = await asyncio.to_thread(
            storage.bucket.sign_url, "GET", storage.pfx + f.storage_key, 600
        )
        return {"url": url}

    # 本地存储：签发 stream token，返回相对路径（浏览器相对当前 origin 解析）
    token = create_stream_token(fid, current_user.id, expires_minutes=10)
    return {"url": f"/api/v1/files/{fid}/stream?token={token}"}


# ── GET /files/{fid}/stream ──────────────────────────────────────────────────

@router.get("/{fid}/stream")
async def stream_file(
    fid: int,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import FileResponse
    from app.services.storage import LocalStorageBackend

    token_fid, user_id = verify_stream_token(token)
    if token_fid != fid:
        raise HTTPException(401, "token 与文件不符")

    f = await get_owned(db, File, fid, user_id)
    if not f:
        raise HTTPException(404, "文件不存在")

    storage = get_storage()
    if not isinstance(storage, LocalStorageBackend):
        raise HTTPException(400, "OSS 后端请使用 stream-url 返回的 presigned URL")

    file_path = storage.root / f.storage_key
    if not file_path.exists():
        raise HTTPException(404, "文件不存在于存储")

    return FileResponse(
        path=str(file_path),
        media_type=f.mime_type or "application/octet-stream",
        filename=f"{f.display_name}.{f.ext.lower()}",
    )
