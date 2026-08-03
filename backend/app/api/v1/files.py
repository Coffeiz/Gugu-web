from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, UploadFile, File as FastAPIFile, Form
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.config import get_settings
from app.core.ownership import get_owned
from app.core.security import get_client_id, get_current_user, verify_stream_token
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import File, User
from app.schemas import FileResponse, FileUpdate, FileTreeResponse, ProjectTreeEntry, BatchDeleteBody, FileCopyBody, BatchDownloadBody
from app.services.files.browser import get_file_tree_rows, get_file_version_snapshot, get_storage_usage, list_existing_file_rows, list_file_rows
from app.services.files.response import color_value, to_file_response, to_related_file_response
from app.services.files.upload import (
    UploadTargetError,
    check_upload_conflicts,
    confirm_oss_upload,
    find_conflict,
    parse_upload_filename,
    presign_upload_url,
    prepare_presign_target,
    validate_oss_upload,
)
from app.services.files.actions import (
    FileContentError,
    FileStreamError,
    build_stream_url,
    delete_file as delete_file_service,
    delete_files,
    read_file_download,
    resolve_local_file_stream,
    update_file_content as update_file_content_service,
)
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.files.selection import build_batch_zip
from app.services.files.previews import (
    IMAGE_MIMES,
    PreviewError,
    delete_thumb_cache,
    pregenerate_thumb,
    read_image_dimensions,
    read_file_thumbnail,
    read_pdf_preview,
)

router = APIRouter(prefix="/files", tags=["files"])

# 单文件上传硬上限（字节）——独立于存储配额，防一次性 read 进内存打爆。
_MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# 版本摘要是无副作用查询，遇到迁移/对账等 DDL 造成的短暂死锁时可以安全重试。
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
    rows = await list_file_rows(
        db,
        current_user.id,
        space=space,
        project_id=project_id,
        folder_id=folder_id,
        mind_map_id=mind_map_id,
        ext=ext,
        query=q,
    )

    return [to_file_response(f, pname, color_value(pcolor), fname) for f, pname, pcolor, fname in rows]


# ── GET /files/all ────────────────────────────────────────────────────────────

@router.get("/all", response_model=list[FileResponse])
async def list_all_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows, changed = await list_existing_file_rows(db, get_storage(), current_user.id)
    if changed:
        await db.commit()

    return [to_file_response(f, pname, color_value(pcolor), fname) for f, pname, pcolor, fname in rows]


# ── GET /files/version ────────────────────────────────────────────────────────

@router.get("/version")
async def files_version(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回文件表状态摘要，用于前端感知服务端变更（删除/修改均会改变结果）。"""
    count, max_updated, max_deleted = await get_file_version_snapshot(db, current_user.id)
    version = f"{count}:{max_updated}:{max_deleted}"
    return {"version": version}


# ── GET /files/storage ───────────────────────────────────────────────────────

@router.get("/storage")
async def files_storage(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户的存储用量与上限。"""
    used = await get_storage_usage(db, current_user.id)
    limit = current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes
    return {"used_bytes": used, "limit_bytes": limit}


# ── GET /files/tree ───────────────────────────────────────────────────────────

@router.get("/tree", response_model=FileTreeResponse)
async def file_tree(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    uid = current_user.id

    project_rows, projects, personal_count = await get_file_tree_rows(db, uid)
    count_map = {pid: count for pid, count in project_rows}

    tree_projects = [
        ProjectTreeEntry(id=p.id, name=p.name, color=color_value(p.color) or p.color,
                         total_count=count_map.get(p.id, 0))
        for p in projects
    ]

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
    conflicts = await check_upload_conflicts(
        db,
        current_user.id,
        ((item.filename, item.space, item.project_id, item.folder_id) for item in body.items),
    )
    for filename, existing in conflicts:
        out.append({
            "filename": filename,
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

    _is_img = bool(mime_type) and mime_type.lower() in IMAGE_MIMES and mime_type.lower() != "image/svg+xml"
    img_width, img_height = read_image_dimensions(data, mime_type)

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

    resp = to_related_file_response(f, result.project, result.folder_name)
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

    upload_url = await presign_upload_url(storage, target, body.mime_type)
    if upload_url is not None:
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
    storage = get_storage()
    try:
        await validate_oss_upload(storage, current_user.id, body.storage_key)
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

    return to_related_file_response(result.file, result.project, result.folder_name)


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

    return to_related_file_response(result.file, result.project, result.folder_name)


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
    try:
        f = await update_file_content_service(
            db, get_storage(), current_user.id, fid, body.content
        )
    except FileContentError as error:
        raise HTTPException(error.status_code, error.detail) from error
    if f is None:
        raise HTTPException(404, "文件不存在")
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
        current_user.id, fid, folder_id=body.folder_id, project_id=body.project_id,
        on_conflict=body.on_conflict, overwrite_file_id=body.overwrite_file_id)
    await db.commit()
    await db.refresh(result.file)
    await events.publish(current_user.id, "files", origin=origin)

    return to_related_file_response(result.file, result.project, result.folder_name)


# ── DELETE /files/{fid} （软删除→回收站）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    moved = await delete_file_service(
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
    file_ids = await delete_files(
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

@router.get("/{fid}/thumb")
async def get_thumb(
    request: Request,
    fid: int,
    size: str = Query("full"),   # "tiny" | "card" | "full"
    db: AsyncSession = Depends(get_db),
):
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
    if mime not in IMAGE_MIMES:
        raise HTTPException(415, "不是图片文件")

    try:
        content, media_type = await read_file_thumbnail(
            get_storage(),
            storage_key=f.storage_key,
            file_id=fid,
            mime_type=mime,
            size=size,
        )
    except FileNotFoundError:
        raise HTTPException(404, "物理文件丢失")
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

    result = await read_file_download(db, get_storage(), current_user.id, fid)
    if result is None:
        raise HTTPException(404, "文件不存在")
    filename = quote(f"{result.file.display_name}.{result.file.ext.lower()}")
    return Response(
        content=result.content,
        media_type=result.file.mime_type or "application/octet-stream",
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

    try:
        pdf = await read_pdf_preview(db, get_storage(), current_user.id, fid)
    except PreviewError as error:
        raise HTTPException(error.status_code, error.detail) from error

    return Response(
        content=pdf,
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
    f = await get_owned(db, File, fid, current_user.id)
    if not f:
        raise HTTPException(404, "文件不存在")

    storage = get_storage()
    return {
        "url": await build_stream_url(
            storage,
            storage_key=f.storage_key,
            file_id=fid,
            user_id=current_user.id,
        )
    }


# ── GET /files/{fid}/stream ──────────────────────────────────────────────────

@router.get("/{fid}/stream")
async def stream_file(
    fid: int,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import FileResponse

    token_fid, user_id = verify_stream_token(token)
    if token_fid != fid:
        raise HTTPException(401, "token 与文件不符")

    try:
        result = await resolve_local_file_stream(db, get_storage(), user_id, fid)
    except FileStreamError as error:
        raise HTTPException(error.status_code, error.detail) from error
    if result is None:
        raise HTTPException(404, "文件不存在")

    return FileResponse(
        path=str(result.path),
        media_type=result.file.mime_type or "application/octet-stream",
        filename=f"{result.file.display_name}.{result.file.ext.lower()}",
    )
