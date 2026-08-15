import io
import zipfile
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Folder, Project, User
from app.schemas import FolderCopy, FolderCreate, FolderMove, FolderRename, FolderResponse
from app.core.security import get_current_user, get_client_id
from app.core.ownership import get_owned
from app.core import events
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.files.browser import folder_download_rows

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
        .where(Folder.user_id == current_user.id, Folder.deleted_at.is_(None))
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
            version=f.version,
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
        .where(Folder.user_id == current_user.id, Folder.deleted_at.is_(None))
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
                       name=f.name, file_count=count_map.get(f.id, 0), version=f.version)
        for f in folders
    ]


# ── POST /folders ─────────────────────────────────────────────────────────────

@router.post("", response_model=FolderResponse, status_code=201)
async def create_folder(
    body: FolderCreate,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    folder = await FileService(db).create_folder(
        current_user.id, name=body.name, parent_id=body.parent_id, project_id=body.project_id,
    )   # 校验（项目归属/同名）在 FolderTree，失败抛领域异常 → 全局 handler 映射 404/409
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin)   # 广播给该用户所有端/标签页；发起页靠 origin 回声抑制
    return FolderResponse(id=folder.id, project_id=folder.project_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=0,
                          version=folder.version)


# ── GET /folders/{fid}/download ──────────────────────────────────────────────

@router.get("/{fid}/download")
async def download_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    download = await folder_download_rows(db, current_user.id, fid)
    if download is None:
        raise HTTPException(404, "文件夹不存在")
    folder, file_rows = download

    storage = get_storage()
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file, arc_name in file_rows:
            data = await storage.get(file.storage_key)
            zf.writestr(arc_name, data)

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
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    folder = await FileService(db).rename_folder(current_user.id, fid, body.name,
                                                  client_version=body.version)
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin)
    cnt = await _file_count(folder.id, db)
    return FolderResponse(id=folder.id, project_id=folder.project_id, name=folder.name,
                          file_count=cnt, version=folder.version)


# ── PATCH /folders/{fid}/parent ──────────────────────────────────────────────

@router.patch("/{fid}/parent", response_model=FolderResponse)
async def move_folder(
    fid: int,
    body: FolderMove,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    folder = await FileService(db).move_folder(current_user.id, fid, body.parent_id,
                                               client_version=body.version,
                                               target_project_id=body.project_id,
                                               target_project_set='project_id' in body.model_fields_set)
    # 归属/循环/跨空间校验在 FolderTree、物理归位在 FileService（relocate），失败抛领域异常
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin)
    cnt = await _file_count(folder.id, db)
    return FolderResponse(id=folder.id, project_id=folder.project_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=cnt,
                          version=folder.version)


@router.post("/{fid}/copy", response_model=FolderResponse)
async def copy_folder(
    fid: int,
    body: FolderCopy,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    folder = await FileService(db).copy_folder(
        current_user.id, fid, parent_id=body.parent_id, project_id=body.project_id,
    )
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin)
    cnt = await _file_count(folder.id, db)
    return FolderResponse(id=folder.id, project_id=folder.project_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=cnt,
                          version=folder.version)


# ── DELETE /folders/{fid} ─────────────────────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    # P2.2：软删（不再硬删）——DB 行仍在、deleted_at 非空、子树内当时存活的文件同批软删并
    # 搬物理 trash，30 天内可整体恢复（FileService.restore_folder）。校验失败抛领域异常
    # （NotFound → 全局 handler 映射 404），与旧行为一致。
    await FileService(db).delete_folder(current_user.id, fid)
    await db.commit()
    # 前端 removeFolder(id) 会本地级联剔除子树文件夹与其中文件，只需给根 folder id
    await events.publish(current_user.id, "files", origin=origin,
                         file_op={"op": "remove", "kind": "folder", "id": fid})
