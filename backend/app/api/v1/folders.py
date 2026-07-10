import io
from app.core.tz import now_utc
import zipfile
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Folder, Project, User
from app.schemas import FolderCreate, FolderMove, FolderRename, FolderResponse
from app.core.security import get_current_user
from app.core.ownership import get_owned
from app.core import events
from app.services.storage import get_storage

router = APIRouter(prefix="/folders", tags=["folders"])


async def _file_count(folder_id: int, db: AsyncSession) -> int:
    return (await db.execute(
        select(func.count()).select_from(File).where(
            File.folder_id == folder_id, File.deleted_at.is_(None)  # 排除回收站，否则删文件后计数不降
        )
    )).scalar_one()


# ── GET /folders/all ─────────────────────────────────────────────────────────

@router.get("/all", response_model=list[FolderResponse])
async def list_all_folders(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folders = (await db.execute(
        select(Folder)
        .where(Folder.user_id == current_user.id)
        .order_by(Folder.created_at)
    )).scalars().all()

    if not folders:
        return []

    counts_res = await db.execute(
        select(File.folder_id, func.count().label("cnt"))
        .where(
            File.folder_id.in_([f.id for f in folders]),
            File.deleted_at.is_(None),
        )
        .group_by(File.folder_id)
    )
    count_map = {row.folder_id: row.cnt for row in counts_res}

    return [
        FolderResponse(
            id=f.id,
            project_id=f.project_id,
            parent_id=f.parent_id,
            name=f.name,
            file_count=count_map.get(f.id, 0),
        )
        for f in folders
    ]


# ── GET /folders?project_id=X  （省略 project_id = 个人文件夹）─────────────────

@router.get("", response_model=list[FolderResponse])
async def list_folders(
    project_id: Optional[int] = None,
    parent_id:  Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_id is not None:
        proj = await get_owned(db, Project, project_id, current_user.id)
        if not proj:
            raise HTTPException(404, "项目不存在")

    stmt = (
        select(Folder)
        .where(Folder.user_id == current_user.id)
        .order_by(Folder.created_at)
    )
    if project_id is not None:
        stmt = stmt.where(Folder.project_id == project_id)
    else:
        stmt = stmt.where(Folder.project_id.is_(None))

    if parent_id is not None:
        stmt = stmt.where(Folder.parent_id == parent_id)
    else:
        stmt = stmt.where(Folder.parent_id.is_(None))

    folders = (await db.execute(stmt)).scalars().all()

    counts_res = await db.execute(
        select(File.folder_id, func.count().label("cnt"))
        .where(
            File.folder_id.in_([f.id for f in folders]),
            File.deleted_at.is_(None),  # 排除回收站，否则删文件后文件夹计数不降（与 /folders/all 一致）
        )
        .group_by(File.folder_id)
    )
    count_map = {row.folder_id: row.cnt for row in counts_res}

    return [
        FolderResponse(id=f.id, project_id=f.project_id, parent_id=f.parent_id,
                       name=f.name, file_count=count_map.get(f.id, 0))
        for f in folders
    ]


# ── POST /folders ─────────────────────────────────────────────────────────────

@router.post("", response_model=FolderResponse, status_code=201)
async def create_folder(
    body: FolderCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.project_id is not None:
        proj = await get_owned(db, Project, body.project_id, current_user.id)
        if not proj:
            raise HTTPException(404, "项目不存在")

    existing = (await db.execute(
        select(Folder).where(
            Folder.user_id == current_user.id,
            Folder.project_id == body.project_id,
            Folder.parent_id == body.parent_id,
            Folder.name == body.name,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "同名文件夹已存在")

    folder = Folder(
        user_id=current_user.id,
        project_id=body.project_id,
        parent_id=body.parent_id,
        name=body.name,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files")   # 广播给该用户所有端/标签页（含发起页），实时刷文件库
    return FolderResponse(id=folder.id, project_id=folder.project_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=0)


# ── GET /folders/{fid}/download ──────────────────────────────────────────────

@router.get("/{fid}/download")
async def download_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folder = await get_owned(db, Folder, fid, current_user.id)
    if not folder:
        raise HTTPException(404, "文件夹不存在")

    storage = get_storage()
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        queue = [(fid, folder.name)]
        while queue:
            current_id, path_prefix = queue.pop(0)

            files = (await db.execute(
                select(File).where(
                    File.folder_id == current_id,
                    File.user_id == current_user.id,
                    File.deleted_at.is_(None),
                )
            )).scalars().all()
            for f in files:
                data = await storage.get(f.storage_key)
                arc_name = f"{path_prefix}/{f.display_name}.{f.ext.lower()}"
                zf.writestr(arc_name, data)

            subfolders = (await db.execute(
                select(Folder).where(
                    Folder.parent_id == current_id,
                    Folder.user_id == current_user.id,
                )
            )).scalars().all()
            for sub in subfolders:
                queue.append((sub.id, f"{path_prefix}/{sub.name}"))

    buf.seek(0)
    filename = quote(f"{folder.name}.zip")
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


# ── PATCH /folders/{fid} ──────────────────────────────────────────────────────

@router.patch("/{fid}", response_model=FolderResponse)
async def rename_folder(
    fid: int,
    body: FolderRename,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folder = await get_owned(db, Folder, fid, current_user.id)
    if not folder:
        raise HTTPException(404, "文件夹不存在")
    folder.name = body.name
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files")
    cnt = await _file_count(folder.id, db)
    return FolderResponse(id=folder.id, project_id=folder.project_id, name=folder.name, file_count=cnt)


# ── PATCH /folders/{fid}/parent ──────────────────────────────────────────────

@router.patch("/{fid}/parent", response_model=FolderResponse)
async def move_folder(
    fid: int,
    body: FolderMove,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folder = await get_owned(db, Folder, fid, current_user.id)
    if not folder:
        raise HTTPException(404, "文件夹不存在")

    new_parent_id = body.parent_id

    if new_parent_id is not None:
        target = await get_owned(db, Folder, new_parent_id, current_user.id)
        if not target:
            raise HTTPException(404, "目标文件夹不存在")
        # Walk up from target to detect circular dependency
        cur = new_parent_id
        visited: set[int] = set()
        while cur is not None:
            if cur == fid:
                raise HTTPException(400, "不能将文件夹移动到自身或其子文件夹中")
            if cur in visited:
                break
            visited.add(cur)
            f = await get_owned(db, Folder, cur, current_user.id)   # 祖先链应全属本人，异常即视为断链
            if f is None:
                break
            cur = f.parent_id

    folder.parent_id = new_parent_id
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files")
    cnt = await _file_count(folder.id, db)
    return FolderResponse(id=folder.id, project_id=folder.project_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=cnt)


# ── DELETE /folders/{fid} ─────────────────────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folder = await get_owned(db, Folder, fid, current_user.id)
    if not folder:
        raise HTTPException(404, "文件夹不存在")

    now = now_utc()

    # 递归收集所有子文件夹 id
    all_fids = [fid]
    queue = [fid]
    while queue:
        parent = queue.pop()
        sub_res = await db.execute(
            select(Folder.id).where(Folder.parent_id == parent, Folder.user_id == current_user.id)
        )
        for sub_id in sub_res.scalars().all():
            all_fids.append(sub_id)
            queue.append(sub_id)

    # 软删除所有层级的文件
    for folder_id in all_fids:
        files_res = await db.execute(
            select(File).where(File.folder_id == folder_id, File.user_id == current_user.id, File.deleted_at.is_(None))
        )
        for f in files_res.scalars().all():
            f.deleted_at = now

    # 删除所有子文件夹（从最深层开始，避免外键约束）；子树 id 虽已按 user_id 收集，删除前仍走归属强制
    for folder_id in reversed(all_fids):
        f = await get_owned(db, Folder, folder_id, current_user.id)
        if f:
            await db.delete(f)

    await db.commit()
    await events.publish(current_user.id, "files")
