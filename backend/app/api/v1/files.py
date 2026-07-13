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
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import _build_key, _resolve_conflict
from app.services.storage.file_service import FileService
from app.services.storage.file_service.files import _fmt_size
from app.services.storage.trash import move_file_to_trash

router = APIRouter(prefix="/files", tags=["files"])

_OFFICE_EXTS = frozenset({'DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX'})
_pdf_cache: dict[str, bytes] = {}   # key: "{fid}:{updated_at_iso}"

# ── 缩略图磁盘缓存 ─────────────────────────────────────────────────────────────

from pathlib import Path as _Path

def _thumb_dir() -> _Path:
    p = _Path(get_settings().storage.local_path) / ".thumbs"
    p.mkdir(parents=True, exist_ok=True)
    return p

def _thumb_path(fid: int, size: str) -> _Path:
    return _thumb_dir() / f"{fid}_{size}.webp"

_THUMB_SIZE_MAP = {"tiny": (20, 75), "card": (192, 82)}

# 单文件上传硬上限（字节）——独立于存储配额，防一次性 read 进内存打爆。
_MAX_UPLOAD_BYTES = 200 * 1024 * 1024

# 缩略图生成是 CPU 密集（解码/缩放/编码）；小核机器上多个并发跑会占满 CPU、卡住其他请求。
# 闸门：最多 (核数-1) 个并发，至少留一个核给事件循环（2 核 → 1）。
_THUMB_SEM = asyncio.Semaphore(max(1, (os.cpu_count() or 2) - 1))

def _generate_thumbs_sync(raw: bytes, fid: int, sizes: tuple = ("tiny",)) -> None:
    """生成指定尺寸的 WebP 缩略图并写入磁盘缓存。在线程中运行。"""
    from PIL import Image
    import io as _io
    td = _thumb_dir()
    img = Image.open(_io.BytesIO(raw))
    # 大图快速降采样解码：JPEG 按目标尺寸 draft 出 1/2~1/8 分辨率，省掉解全分辨率的大头开销（非 JPEG 无效，安全）
    try:
        _biggest = max(_THUMB_SIZE_MAP[s][0] for s in sizes)
        img.draft(None, (_biggest, _biggest))
    except Exception:
        pass
    # 保留 RGBA（PNG 透明通道），其余统一转 RGB
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA") if "transparency" in img.info else img.convert("RGB")
    for size_name in sizes:
        max_px, quality = _THUMB_SIZE_MAP[size_name]
        out = img.copy()
        out.thumbnail((max_px, max_px), Image.LANCZOS)
        buf = _io.BytesIO()
        out.save(buf, format="WEBP", quality=quality)
        (td / f"{fid}_{size_name}.webp").write_bytes(buf.getvalue())

def _generate_thumb_jpeg_fallback(raw: bytes, size: str) -> bytes | None:
    """WebP 生成失败时的降级：强制 RGB，输出缩小的 JPEG，避免返回原始大图。"""
    from PIL import Image
    import io as _io
    try:
        img = Image.open(_io.BytesIO(raw))
        max_px, _ = _THUMB_SIZE_MAP.get(size, (192, 82))
        try:
            img.draft(None, (max_px, max_px))   # JPEG 大图快速降采样解码
        except Exception:
            pass
        # 取动图第一帧，强制转 RGB
        if hasattr(img, "n_frames") and img.n_frames > 1:
            img.seek(0)
        img = img.convert("RGB")
        img.thumbnail((max_px, max_px), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
    except Exception:
        return None

def _delete_thumb_cache(fid: int) -> None:
    for size in ("tiny", "card"):
        for ext in (".webp", ".jpg"):
            p = _thumb_dir() / f"{fid}_{size}{ext}"
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass


async def _find_conflict(db: AsyncSession, user_id, space: str, project_id: Optional[int],
                          folder_id: Optional[int], display_name: str, ext: str) -> Optional[File]:
    """同一空间/项目/文件夹下，是否已经存在「同名 + 同扩展名」的未删除文件。"""
    stmt = select(File).where(
        File.user_id == user_id, File.deleted_at.is_(None),
        File.space == space, File.display_name == display_name, File.ext == ext.upper(),
    )
    stmt = stmt.where(File.project_id == project_id) if project_id is not None else stmt.where(File.project_id.is_(None))
    stmt = stmt.where(File.folder_id == folder_id) if folder_id is not None else stmt.where(File.folder_id.is_(None))
    return (await db.execute(stmt)).scalars().first()


def _color(raw: str | None) -> str | None:
    if not raw:
        return None
    m = re.search(r'#[0-9a-fA-F]{3,6}', raw)
    return m.group(0) if m else raw


def _to_resp(f: File, project_name: str | None = None, project_color: str | None = None,
             folder_name: str | None = None) -> FileResponse:
    return FileResponse(
        id=f.id,
        display_name=f.display_name,
        ext=f.ext,
        space=f.space,
        project_id=f.project_id,
        project_name=project_name,
        project_color=project_color,
        stage_name=f.stage_name,
        folder_id=f.folder_id,
        folder_name=folder_name,
        mind_map_id=f.mind_map_id,
        size=f.size,
        size_bytes=f.size_bytes,
        mime_type=f.mime_type,
        created_at=f.created_at.strftime("%Y-%m-%d"),
        deleted_at=f.deleted_at.strftime("%Y-%m-%dT%H:%M:%S") if f.deleted_at else None,
        img_width=f.img_width,
        img_height=f.img_height,
    )


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
    stmt = (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(File.user_id == current_user.id, File.deleted_at.is_(None))
        .order_by(File.created_at.desc())
    )
    if space:
        stmt = stmt.where(File.space == space)
    if project_id is not None:
        stmt = stmt.where(File.project_id == project_id)
    if folder_id is not None:
        stmt = stmt.where(File.folder_id == folder_id)
    elif folder_id is None and project_id is not None and space == "project":
        # 只查项目根文件（未归入任何文件夹）
        stmt = stmt.where(File.folder_id.is_(None))
    elif folder_id is None and project_id is None and space == "personal":
        # 只查个人根文件（未归入任何文件夹）
        stmt = stmt.where(File.folder_id.is_(None))
    if mind_map_id is not None:
        stmt = stmt.where(File.mind_map_id == mind_map_id)
    if ext:
        stmt = stmt.where(File.ext == ext.upper())
    if q:
        stmt = stmt.where(File.display_name.ilike(f"%{q}%"))

    result = await db.execute(stmt)
    return [_to_resp(f, pname, _color(pcolor), fname) for f, pname, pcolor, fname in result.all()]


# ── GET /files/all ────────────────────────────────────────────────────────────

@router.get("/all", response_model=list[FileResponse])
async def list_all_files(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(File.user_id == current_user.id, File.deleted_at.is_(None))
        .order_by(File.created_at.desc())
    )
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

    return [_to_resp(f, pname, _color(pcolor), fname) for f, pname, pcolor, fname in rows]


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
        select(func.sum(File.size_bytes)).where(
            File.user_id == current_user.id,
            File.deleted_at.is_(None),
        )
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
        ProjectTreeEntry(id=p.id, name=p.name, color=_color(p.color) or p.color,
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
        parts = item.filename.rsplit(".", 1)
        display_name = parts[0]
        ext = parts[1].upper()[:10] if len(parts) > 1 else "FILE"
        existing = await _find_conflict(db, current_user.id, item.space, item.project_id, item.folder_id, display_name, ext)
        out.append({
            "filename": item.filename,
            "conflict": existing is not None,
            "existing_file": _to_resp(existing).model_dump() if existing else None,
        })
    return out


# ── POST /files ───────────────────────────────────────────────────────────────

async def _pregen_thumb(storage_key: str, fid: int) -> None:
    """上传完成后在后台预生成缩略图，避免首次访问时等待。"""
    import asyncio
    try:
        raw = await get_storage().get(storage_key)
        async with _THUMB_SEM:
            await asyncio.to_thread(_generate_thumbs_sync, raw, fid)
    except Exception:
        pass


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
    parts = original_name.rsplit(".", 1)
    display_name = parts[0]
    ext = parts[1].upper()[:10] if len(parts) > 1 else "FILE"
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
        _delete_thumb_cache(f.id)   # 旧缩略图必须清，否则还显示覆盖前的图

    await db.commit()
    await db.refresh(f)
    if not result.was_overwrite:
        await events.publish(current_user.id, "files", origin=origin)

    project_name = result.project.name if result.project else None
    project_color = _color(result.project.color) if result.project else None
    resp = _to_resp(f, project_name, project_color, result.folder_name)
    if _is_img:
        background_tasks.add_task(_pregen_thumb, f.storage_key, f.id)
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

    parts = body.filename.rsplit(".", 1)
    display_name = parts[0]
    ext = parts[1].upper()[:10] if len(parts) > 1 else "FILE"

    project_name = ""
    project_color = None
    project_year = ""
    project_month = ""
    folder_name = folder_path = ""

    if body.space == "project" and body.project_id:
        p = await get_owned(db, Project, body.project_id, current_user.id)
        if not p:
            raise HTTPException(400, "项目不存在")
        project_name = p.name
        project_color = _color(p.color)
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    elif body.space == "project":
        raise HTTPException(400, "project 空间需要提供 project_id")

    if body.folder_id is not None:
        resolved = await resolve_folder_path(db, current_user.id, body.folder_id, body.project_id)
        if not resolved or resolved[0].deleted_at is not None:   # 不能传进已软删的文件夹（P2）
            raise HTTPException(400, "文件夹不存在，或不属于指定的项目/个人空间")
        fo, folder_path = resolved
        folder_name = fo.name

    storage = get_storage()

    # 覆盖已有同名文件：直接对已有文件的 storage_key 签 URL，不再走 _resolve_conflict 改名；
    # 配额按新旧大小差值算。
    existing = None
    if body.on_conflict == "overwrite" and body.overwrite_file_id is not None:
        existing = await get_owned(db, File, body.overwrite_file_id, current_user.id)
        if not existing:
            raise HTTPException(400, "要覆盖的文件不存在")
        final_key, final_name = existing.storage_key, existing.display_name

        _storage_limit = current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes
        if _storage_limit is not None:
            used_res = await db.execute(select(func.sum(File.size_bytes)).where(File.user_id == current_user.id))
            used = used_res.scalar() or 0
            if used - existing.size_bytes + body.size_bytes > _storage_limit:
                raise HTTPException(status_code=400, detail="存储空间已满，无法上传")
    else:
        base_key = _build_key(
            uid=current_user.id,
            space=body.space,
            display_name=display_name,
            ext=ext,
            project_name=project_name,
            project_id=body.project_id or 0,
            project_year=project_year,
            project_month=project_month,
            folder_path=folder_path,
        )
        final_key, final_name = await _resolve_conflict(storage, base_key, display_name, ext)

        _storage_limit = current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes
        if _storage_limit is not None:
            used_res = await db.execute(
                select(func.sum(File.size_bytes)).where(File.user_id == current_user.id)
            )
            used = used_res.scalar() or 0
            if used + body.size_bytes > _storage_limit:
                raise HTTPException(status_code=400, detail="存储空间已满，无法上传")

    if isinstance(storage, OSSStorageBackend):
        import asyncio as _asyncio
        upload_url = await _asyncio.to_thread(
            storage.presign_put, final_key, body.mime_type, 600
        )
        return {
            "mode": "oss",
            "upload_url": upload_url,
            "storage_key": final_key,
            "final_name": final_name,
            "ext": ext,
            "overwrite_file_id": existing.id if existing else None,
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

    project_name = ""
    project_color = None
    folder_name = folder_path = ""

    if body.space == "project" and body.project_id:
        p = await get_owned(db, Project, body.project_id, current_user.id)
        if not p:
            raise HTTPException(400, "项目不存在")
        project_name = p.name
        project_color = _color(p.color)

    if body.folder_id is not None:
        fo = await get_owned(db, Folder, body.folder_id, current_user.id)
        if not fo:
            raise HTTPException(400, "文件夹不存在")
        folder_name = fo.name

    if body.overwrite_file_id is not None:
        existing = await get_owned(db, File, body.overwrite_file_id, current_user.id)
        if not existing:
            raise HTTPException(400, "要覆盖的文件不存在")
        if existing.storage_key != body.storage_key:
            raise HTTPException(400, "覆盖目标与直传路径不一致")
        _delete_thumb_cache(existing.id)
        existing.size = _fmt_size(body.size_bytes)
        existing.size_bytes = body.size_bytes
        existing.mime_type = body.mime_type
        await db.commit()
        await db.refresh(existing)
        await events.publish(current_user.id, "files", origin=origin)
        return _to_resp(existing, project_name or None, project_color, folder_name or None)

    db_file = File(
        user_id=current_user.id,
        display_name=body.display_name,
        ext=body.ext,
        space=body.space,
        project_id=body.project_id if body.space == "project" else None,
        folder_id=body.folder_id,
        stage_name=body.stage_name,
        storage_key=body.storage_key,
        size=_fmt_size(body.size_bytes),
        size_bytes=body.size_bytes,
        mime_type=body.mime_type,
    )
    db.add(db_file)
    await db.commit()
    await db.refresh(db_file)
    await events.publish(current_user.id, "files", origin=origin)

    return _to_resp(db_file, project_name or None, project_color, folder_name or None)


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
    project_color = _color(result.project.color) if result.project else None
    return _to_resp(result.file, project_name, project_color, result.folder_name)


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
    return _to_resp(f)


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
    project_color = _color(result.project.color) if result.project else None
    return _to_resp(result.file, project_name, project_color, result.folder_name)


# ── DELETE /files/{fid} （软删除→回收站）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at is not None:
        raise HTTPException(404, "文件不存在")
    await move_file_to_trash(get_storage(), f)
    f.deleted_at = now_utc()
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
    stmt = select(File).where(
        File.id.in_(body.ids),
        File.user_id == current_user.id,
        File.deleted_at.is_(None),
    )
    files = (await db.execute(stmt)).scalars().all()
    storage = get_storage()
    now = now_utc()
    for f in files:
        await move_file_to_trash(storage, f)
        f.deleted_at = now
    await db.commit()
    await events.publish(current_user.id, "files", origin=origin,
                         file_op={"op": "remove", "kind": "file", "ids": [f.id for f in files]})


# ── POST /files/batch-download ───────────────────────────────────────────────

@router.post("/batch-download")
async def batch_download_files(
    body: BatchDownloadBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    import io, zipfile
    from fastapi.responses import Response

    if not body.ids and not body.folder_ids:
        raise HTTPException(400, "未选择文件")

    storage = get_storage()
    buf = io.BytesIO()

    # (arc_path, file_obj) 列表
    entries: list[tuple[str, File]] = []

    # 1. 散装文件
    if body.ids:
        rows = (await db.execute(
            select(File).where(
                File.id.in_(body.ids),
                File.user_id == current_user.id,
                File.deleted_at.is_(None),
            )
        )).scalars().all()
        for f in rows:
            entries.append((f"{f.display_name}.{f.ext.lower()}", f))

    # 2. 文件夹（递归）
    async def collect_folder(folder_id: int, prefix: str):
        folder = await get_owned(db, Folder, folder_id, current_user.id)
        if not folder:
            return
        folder_prefix = f"{prefix}{folder.name}/"
        # 该文件夹内的文件
        files = (await db.execute(
            select(File).where(
                File.folder_id == folder_id,
                File.user_id == current_user.id,
                File.deleted_at.is_(None),
            )
        )).scalars().all()
        for f in files:
            entries.append((f"{folder_prefix}{f.display_name}.{f.ext.lower()}", f))
        # 子文件夹
        children = (await db.execute(
            select(Folder).where(Folder.parent_id == folder_id, Folder.user_id == current_user.id)
        )).scalars().all()
        for child in children:
            await collect_folder(child.id, folder_prefix)

    for fid in body.folder_ids:
        await collect_folder(fid, "")

    if not entries:
        raise HTTPException(404, "未找到可下载的文件")

    # 去重 arc_path
    seen: dict[str, int] = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for arc_path, f in entries:
            if arc_path in seen:
                seen[arc_path] += 1
                stem, ext = arc_path.rsplit(".", 1) if "." in arc_path else (arc_path, "")
                arc_path = f"{stem}_{seen[arc_path]}.{ext}" if ext else f"{stem}_{seen[arc_path]}"
            else:
                seen[arc_path] = 0
            data = await storage.get(f.storage_key)
            zf.writestr(arc_path, data)

    buf.seek(0)
    return Response(
        content=buf.read(),
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

    # 命中磁盘缓存：touch mtime 供 TTL 驱逐参考
    cache_path = _thumb_path(fid, size)
    if cache_path.exists():
        cache_path.touch()
        return FastAPIResponse(content=cache_path.read_bytes(), media_type="image/webp",
                               headers={"Cache-Control": "private, max-age=86400"})

    # 缓存 miss：读原图，按需生成请求的尺寸（card 不在上传时预生成）
    try:
        raw = await get_storage().get(f.storage_key)
    except FileNotFoundError:
        raise HTTPException(404, "物理文件丢失")
    try:
        async with _THUMB_SEM:
            await asyncio.to_thread(_generate_thumbs_sync, raw, fid, (size,))
        cache_path = _thumb_path(fid, size)
        if cache_path.exists():
            return FastAPIResponse(content=cache_path.read_bytes(), media_type="image/webp",
                                   headers={"Cache-Control": "private, max-age=86400"})
    except Exception as e:
        import traceback
        print(f"[缩略图] WebP 生成失败 fid={fid} size={size}: {e}\n{traceback.format_exc()}")

    # 降级：WebP 失败时返回缩小的 JPEG，保证不返回原始大图
    try:
        async with _THUMB_SEM:
            jpeg_bytes = await asyncio.to_thread(_generate_thumb_jpeg_fallback, raw, size)
        if jpeg_bytes:
            return FastAPIResponse(content=jpeg_bytes, media_type="image/jpeg",
                                   headers={"Cache-Control": "private, max-age=86400"})
    except Exception:
        pass

    # 最后兜底：返回原图
    return FastAPIResponse(content=raw, media_type=mime,
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

async def _office_to_pdf(data: bytes, ext: str) -> bytes:
    import asyncio, shutil, tempfile
    from pathlib import Path as _Path

    tmpdir = _Path(tempfile.mkdtemp())
    try:
        src = tmpdir / f"input.{ext.lower()}"
        src.write_bytes(data)
        # -env:UserInstallation 把 LibreOffice 的用户配置目录指到本次专属的临时目录：
        # systemd 服务开了 ProtectSystem=strict，$HOME/.config 对进程是只读的，LibreOffice
        # 默认要在那建 profile，建不了直接 returncode=1（stderr 只有条不相关的 javaldx 警告，
        # 真实原因被吞掉）。指到 tmpdir 下（PrivateTmp=true 保证可写），每次调用互不干扰。
        proc = await asyncio.create_subprocess_exec(
            "libreoffice", "--headless",
            f"-env:UserInstallation=file://{tmpdir}/loprofile",
            "--convert-to", "pdf",
            "--outdir", str(tmpdir), str(src),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(422, "文档转换超时")
        if proc.returncode != 0:
            raise HTTPException(422, "文档转换失败：" + (stderr.decode(errors="replace")[:200]))
        pdf = tmpdir / "input.pdf"
        if not pdf.exists():
            raise HTTPException(422, "转换结果为空")
        return pdf.read_bytes()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


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
        _pdf_cache[cache_key] = await _office_to_pdf(raw, f.ext)

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
