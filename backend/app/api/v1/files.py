import asyncio
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
from app.core.security import get_current_user, create_stream_token, verify_stream_token
from app.core.ownership import get_owned
from app.core.config import get_settings
from app.services.storage import get_storage

router = APIRouter(prefix="/files", tags=["files"])

_INVALID_RE  = re.compile(r'[\\/:*?"<>|]')
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


def _fmt_size(size_bytes: int) -> str:
    if size_bytes >= 1_000_000:
        return f"{size_bytes / 1_000_000:.1f} MB"
    return f"{size_bytes / 1024:.0f} KB"


def _safe_name(name: str) -> str:
    return _INVALID_RE.sub("_", name)


def _build_key(uid: int, space: str, display_name: str, ext: str,
               project_name: str = "", project_id: int = 0,
               project_year: str = "", project_month: str = "",
               folder_name: str = "", mind_map_title: str = "", mind_map_id: int = 0) -> str:
    fname = f"{_safe_name(display_name)}.{ext.lower()}"
    if space == "project":
        proj_dir = f"{_safe_name(project_name)} #{project_id}"
        date_path = f"{project_year}/{project_month}/" if project_year and project_month else ""
        if folder_name:
            return f"{uid}/项目文件/{date_path}{proj_dir}/{_safe_name(folder_name)}/{fname}"
        return f"{uid}/项目文件/{date_path}{proj_dir}/{fname}"
    if space == "mind":
        map_dir = f"{_safe_name(mind_map_title)} #{mind_map_id}"
        return f"{uid}/思维/{map_dir}/{fname}"
    if space == "asset":
        return f"{uid}/素材板/{fname}"
    # personal — 有文件夹时放进子目录
    if folder_name:
        return f"{uid}/个人文件/{_safe_name(folder_name)}/{fname}"
    return f"{uid}/个人文件/{fname}"


async def _resolve_conflict(storage, base_key: str, display_name: str, ext: str) -> tuple[str, str]:
    key = base_key
    name = display_name
    n = 0
    from app.services.storage import LocalStorageBackend
    if not isinstance(storage, LocalStorageBackend):
        return key, name
    from pathlib import Path
    root = storage.root
    while (root / key).exists():
        n += 1
        name = f"{display_name}({n})"
        prefix = base_key.rsplit("/", 1)[0]
        key = f"{prefix}/{_safe_name(name)}.{ext.lower()}"
    return key, name


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
        now = datetime.utcnow()
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
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    original_name = file.filename or "file"
    parts = original_name.rsplit(".", 1)
    display_name = parts[0]
    ext = parts[1].upper()[:10] if len(parts) > 1 else "FILE"
    mime_type = file.content_type

    project_name = ""
    project_color = None
    project_year = ""
    project_month = ""
    folder_name = ""
    if space == "project" and project_id:
        p = await get_owned(db, Project, project_id, current_user.id)
        if not p:
            raise HTTPException(400, "项目不存在")
        project_name = p.name
        project_color = _color(p.color)
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    elif space == "project":
        raise HTTPException(400, "project 空间需要提供 project_id")

    if folder_id is not None:
        fo = await get_owned(db, Folder, folder_id, current_user.id)
        if not fo:
            raise HTTPException(400, "文件夹不存在")
        folder_name = fo.name

    base_key = _build_key(
        uid=current_user.id,
        space=space,
        display_name=display_name,
        ext=ext,
        project_name=project_name,
        project_id=project_id or 0,
        project_year=project_year,
        project_month=project_month,
        folder_name=folder_name,
    )

    storage = get_storage()
    final_key, final_name = await _resolve_conflict(storage, base_key, display_name, ext)

    data = await file.read()
    size_bytes = len(data)

    # 检查存储配额（优先个人配额，fallback 全局默认）
    _storage_limit = current_user.storage_limit_bytes or get_settings().quota.default_storage_limit_bytes
    if _storage_limit is not None:
        used_res = await db.execute(
            select(func.sum(File.size_bytes)).where(File.user_id == current_user.id)
        )
        used = used_res.scalar() or 0
        if used + size_bytes > _storage_limit:
            raise HTTPException(status_code=400, detail="存储空间已满，无法上传")

    await storage.put(final_key, data, mime_type)

    img_width, img_height = None, None
    if mime_type and mime_type.lower() in _IMAGE_MIMES and mime_type.lower() != "image/svg+xml":
        try:
            from PIL import Image as _PILImage
            import io as _io
            _pil = _PILImage.open(_io.BytesIO(data))
            img_width, img_height = _pil.size
            _pil.close()
        except Exception:
            pass

    db_file = File(
        user_id=current_user.id,
        display_name=final_name,
        ext=ext,
        space=space,
        project_id=project_id if space == "project" else None,
        folder_id=folder_id,
        stage_name=stage_name,
        mind_map_id=mind_map_id if space == "mind" else None,
        storage_key=final_key,
        size=_fmt_size(size_bytes),
        size_bytes=size_bytes,
        mime_type=mime_type,
        img_width=img_width,
        img_height=img_height,
    )
    db.add(db_file)
    await db.commit()
    await db.refresh(db_file)

    resp = _to_resp(db_file, project_name or None, project_color, folder_name or None)

    # 图片文件：后台预生成缩略图缓存
    if mime_type and mime_type.lower() in _IMAGE_MIMES \
            and mime_type.lower() != "image/svg+xml":
        background_tasks.add_task(_pregen_thumb, final_key, db_file.id)

    return resp


# ── POST /files/presign ───────────────────────────────────────────────────────

from pydantic import BaseModel as _BaseModel

class PresignRequest(_BaseModel):
    filename: str
    size_bytes: int
    mime_type: str = "application/octet-stream"
    space: str = "personal"
    project_id: Optional[int] = None
    folder_id: Optional[int] = None
    stage_name: str = ""


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
    folder_name = ""

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
        fo = await get_owned(db, Folder, body.folder_id, current_user.id)
        if not fo:
            raise HTTPException(400, "文件夹不存在")
        folder_name = fo.name

    base_key = _build_key(
        uid=current_user.id,
        space=body.space,
        display_name=display_name,
        ext=ext,
        project_name=project_name,
        project_id=body.project_id or 0,
        project_year=project_year,
        project_month=project_month,
        folder_name=folder_name,
    )

    storage = get_storage()
    final_key, final_name = await _resolve_conflict(storage, base_key, display_name, ext)

    # 配额检查
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


@router.post("/confirm", response_model=FileResponse, status_code=201)
async def confirm_upload(
    body: ConfirmRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """OSS 直传完成后，注册 DB 记录。"""
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
    folder_name = ""

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

    return _to_resp(db_file, project_name or None, project_color, folder_name or None)


# ── PATCH /files/{fid} ───────────────────────────────────────────────────────

@router.patch("/{fid}", response_model=FileResponse)
async def update_file(
    fid: int,
    body: FileUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await get_owned(db, File, fid, current_user.id)
    if not f:
        raise HTTPException(404, "文件不存在")

    new_display = body.display_name if body.display_name is not None else f.display_name
    new_stage   = body.stage_name   if body.stage_name   is not None else f.stage_name
    # folder_id 显式出现在请求体时（含 null）才更新，否则保持原值
    new_fid = body.folder_id if 'folder_id' in body.model_fields_set else f.folder_id

    project_name = ""
    project_color = None
    project_year = ""
    project_month = ""
    folder_name = ""
    if f.space == "project" and f.project_id:
        p = await get_owned(db, Project, f.project_id, current_user.id)
        if p:
            project_name = p.name
            project_color = _color(p.color)
            date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
    if new_fid:
        fo = await get_owned(db, Folder, new_fid, current_user.id)
        if not fo:
            raise HTTPException(400, "目标文件夹不存在")
        folder_name = fo.name

    new_key = _build_key(
        uid=current_user.id,
        space=f.space,
        display_name=new_display,
        ext=f.ext,
        project_name=project_name,
        project_id=f.project_id or 0,
        project_year=project_year,
        project_month=project_month,
        folder_name=folder_name,
    )

    if new_key != f.storage_key:
        storage = get_storage()
        new_key, new_display = await _resolve_conflict(storage, new_key, new_display, f.ext)
        await storage.rename_file(f.storage_key, new_key)
        f.storage_key = new_key

    f.display_name = new_display
    f.stage_name   = new_stage
    f.folder_id    = new_fid
    f.updated_at   = datetime.utcnow()
    await db.commit()
    await db.refresh(f)

    return _to_resp(f, project_name or None, project_color, folder_name or None)


class _FileContentBody(_BaseModel):
    content: str


@router.put("/{fid}/content", response_model=FileResponse)
async def update_file_content(
    fid: int,
    body: _FileContentBody,
    current_user: User = Depends(get_current_user),
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
    f.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(f)
    return _to_resp(f)


# ── POST /files/{fid}/copy ────────────────────────────────────────────────────

@router.post("/{fid}/copy", response_model=FileResponse)
async def copy_file(
    fid: int,
    body: FileCopyBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at:
        raise HTTPException(404, "文件不存在")

    new_folder_id  = body.folder_id
    new_project_id = body.project_id if body.project_id is not None else f.project_id
    new_space      = f.space

    project_name = ""; project_color = None; project_year = ""; project_month = ""
    if new_space == "project" and new_project_id:
        p = await get_owned(db, Project, new_project_id, current_user.id)
        if not p:
            raise HTTPException(400, "目标项目不存在")
        project_name  = p.name; project_color = _color(p.color)
        date_str      = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]

    folder_name = ""
    if new_folder_id:
        fo = await get_owned(db, Folder, new_folder_id, current_user.id)
        if not fo:
            raise HTTPException(400, "目标文件夹不存在")
        folder_name = fo.name

    base_key = _build_key(
        uid=current_user.id, space=new_space, display_name=f.display_name,
        ext=f.ext, project_name=project_name, project_id=new_project_id or 0,
        project_year=project_year, project_month=project_month, folder_name=folder_name,
    )
    storage = get_storage()
    new_key, new_display = await _resolve_conflict(storage, base_key, f.display_name, f.ext)

    data = await storage.get(f.storage_key)
    await storage.put(new_key, data, f.mime_type)

    new_file = File(
        user_id=current_user.id, display_name=new_display, ext=f.ext,
        storage_key=new_key, size=f.size, mime_type=f.mime_type, space=new_space,
        project_id=new_project_id, folder_id=new_folder_id,
        stage_name=f.stage_name,
    )
    db.add(new_file)
    await db.commit()
    await db.refresh(new_file)
    return _to_resp(new_file, project_name or None, project_color, folder_name or None)


# ── DELETE /files/{fid} （软删除→回收站）────────────────────────────────────

def _to_trash_key(user_id, fid: int, storage_key: str) -> str:
    """生成回收站路径，保留原文件名方便识别。"""
    return f"{user_id}/trash/{fid}/{storage_key.rsplit('/', 1)[-1]}"


async def _move_to_trash(storage, f: File) -> None:
    """把物理文件移入回收站目录，更新 storage_key；失败时静默忽略。"""
    if f.storage_key.startswith("_trash_/"):
        return  # 已在回收站
    trash_key = _to_trash_key(f.user_id, f.id, f.storage_key)
    try:
        await storage.rename_file(f.storage_key, trash_key)
        f.storage_key = trash_key
    except Exception:
        pass


@router.delete("/{fid}", status_code=204)
async def delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at is not None:
        raise HTTPException(404, "文件不存在")
    await _move_to_trash(get_storage(), f)
    f.deleted_at = datetime.utcnow()
    await db.commit()


# ── POST /files/batch-delete ──────────────────────────────────────────────────

@router.post("/batch-delete", status_code=204)
async def batch_delete_files(
    body: BatchDeleteBody,
    current_user: User = Depends(get_current_user),
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
    now = datetime.utcnow()
    for f in files:
        await _move_to_trash(storage, f)
        f.deleted_at = now
    await db.commit()


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
        proc = await asyncio.create_subprocess_exec(
            "libreoffice", "--headless", "--convert-to", "pdf",
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
