import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File as FastAPIFile, Form
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Folder, Project, User
from app.schemas import FileResponse, FileUpdate, FileTreeResponse, ProjectTreeEntry, BatchDeleteBody
from app.core.security import get_current_user
from app.services.storage import get_storage

router = APIRouter(prefix="/files", tags=["files"])

_INVALID_RE = re.compile(r'[\\/:*?"<>|]')


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
    if mind_map_id is not None:
        stmt = stmt.where(File.mind_map_id == mind_map_id)
    if ext:
        stmt = stmt.where(File.ext == ext.upper())
    if q:
        stmt = stmt.where(File.display_name.ilike(f"%{q}%"))

    result = await db.execute(stmt)
    return [_to_resp(f, pname, _color(pcolor), fname) for f, pname, pcolor, fname in result.all()]


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

@router.post("", response_model=FileResponse, status_code=201)
async def upload_file(
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
        p = await db.get(Project, project_id)
        if not p or p.user_id != current_user.id:
            raise HTTPException(400, "项目不存在")
        project_name = p.name
        project_color = _color(p.color)
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    elif space == "project":
        raise HTTPException(400, "project 空间需要提供 project_id")

    if folder_id is not None:
        fo = await db.get(Folder, folder_id)
        if not fo or fo.user_id != current_user.id:
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
    await storage.put(final_key, data, mime_type)

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
    f = await db.get(File, fid)
    if not f or f.user_id != current_user.id:
        raise HTTPException(404, "文件不存在")

    new_display = body.display_name if body.display_name is not None else f.display_name
    new_stage   = body.stage_name   if body.stage_name   is not None else f.stage_name
    new_fid     = body.folder_id    if body.folder_id    is not None else f.folder_id

    project_name = ""
    project_color = None
    project_year = ""
    project_month = ""
    folder_name = ""
    if f.space == "project" and f.project_id:
        p = await db.get(Project, f.project_id)
        if p:
            project_name = p.name
            project_color = _color(p.color)
            date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
    if new_fid:
        fo = await db.get(Folder, new_fid)
        if fo:
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


# ── DELETE /files/{fid} （软删除→回收站）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await db.get(File, fid)
    if not f or f.user_id != current_user.id or f.deleted_at is not None:
        raise HTTPException(404, "文件不存在")
    f.deleted_at = datetime.utcnow()
    await db.commit()


# ── POST /files/batch-delete ──────────────────────────────────────────────────

@router.post("/batch-delete", status_code=204)
async def batch_delete_files(
    body: BatchDeleteBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import update as sa_update
    await db.execute(
        sa_update(File)
        .where(File.id.in_(body.ids), File.user_id == current_user.id, File.deleted_at.is_(None))
        .values(deleted_at=datetime.utcnow())
    )
    await db.commit()


# ── GET /files/{fid}/download ────────────────────────────────────────────────

@router.get("/{fid}/download")
async def download_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import Response
    from urllib.parse import quote

    f = await db.get(File, fid)
    if not f or f.user_id != current_user.id:
        raise HTTPException(404, "文件不存在")
    data = await get_storage().get(f.storage_key)
    filename = quote(f"{f.display_name}.{f.ext.lower()}")
    return Response(
        content=data,
        media_type=f.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )
