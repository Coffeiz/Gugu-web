import logging
from datetime import datetime, timedelta
from app.core.tz import now_utc

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Project, Folder, User
from app.schemas import (
    BatchDeleteBody,
    FileResponse,
    FolderResponse,
    TrashFolderContentsResponse,
    TrashFolderResponse,
)
from app.core.security import get_current_user, get_client_id
from app.core import events
from app.services.files.trash import (
    RestoreParentTrashError,
    permanently_delete_file,
    permanently_delete_folder,
    top_level_deleted_folders_stmt,
    get_top_level_deleted_folder,
    list_trash_file_rows,
    list_trash_folder_contents_rows,
    empty_trash as empty_trash_service,
    restore_file_by_id,
    restore_files_by_ids,
)
from app.services.files.previews import delete_thumb_cache
from app.services.files.response import color_value, to_file_response
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.storage.folders import folder_dir_key

router = APIRouter(prefix="/trash", tags=["trash"])

TRASH_DAYS = 30
_log = logging.getLogger("app.api.v1.trash")


# ── GET /trash ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[FileResponse])
async def list_trash(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return [
        to_file_response(f, pname, color_value(pcolor), fname)
        for f, pname, pcolor, fname in await list_trash_file_rows(db, current_user.id)
    ]


# ── GET /trash/folders （P2.3：顶层已删文件夹）───────────────────────────────

@router.get("/folders", response_model=list[TrashFolderResponse])
async def list_trash_folders(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folders = (await db.execute(top_level_deleted_folders_stmt(current_user.id))).scalars().all()
    if not folders:
        return []
    # 浅层计数：该文件夹自身直接包含、已在回收站的文件数（同现有 _file_count 的浅层惯例）
    counts_res = await db.execute(
        select(File.folder_id, func.count().label("cnt"))
        .where(File.folder_id.in_([f.id for f in folders]), File.deleted_at.isnot(None))
        .group_by(File.folder_id)
    )
    count_map = {row.folder_id: row.cnt for row in counts_res}
    return [
        TrashFolderResponse(
            id=f.id, project_id=f.project_id, parent_id=f.parent_id, name=f.name,
            file_count=count_map.get(f.id, 0), version=f.version,
            deleted_at=f.deleted_at.strftime("%Y-%m-%dT%H:%M:%S"),
        )
        for f in folders
    ]


@router.get("/folders/{fid}/contents", response_model=TrashFolderContentsResponse)
async def list_trash_folder_contents(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取顶层回收站文件夹的直属内容，内部文件不作为独立恢复单元。"""
    contents = await list_trash_folder_contents_rows(db, current_user.id, fid)
    if not contents:
        raise HTTPException(404, "文件夹不存在")
    folder, child_folders, direct_files, count_map = contents
    return TrashFolderContentsResponse(
        folders=[TrashFolderResponse(
            id=f.id, project_id=f.project_id, parent_id=f.parent_id, name=f.name,
            file_count=count_map.get(f.id, 0), version=f.version,
            deleted_at=f.deleted_at.strftime("%Y-%m-%dT%H:%M:%S"),
        ) for f in child_folders],
        files=[to_file_response(f, pname, color_value(pcolor), fname)
               for f, pname, pcolor, fname in direct_files],
    )


# ── POST /trash/folders/{fid}/restore （P2.4）────────────────────────────────

@router.post("/folders/{fid}/restore", response_model=FolderResponse)
async def restore_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    folder = await FileService(db).restore_folder(current_user.id, fid)
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin)
    return FolderResponse(id=folder.id, project_id=folder.project_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=0,
                          version=folder.version)


# ── DELETE /trash/folders/{fid} （永久删除顶层文件夹）──────────────────────────

@router.delete("/folders/{fid}", status_code=204)
async def hard_delete_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    # 只允许删除回收站中可见的顶层恢复单元，避免绕开父文件夹删掉子树中的一个节点。
    folder = await get_top_level_deleted_folder(db, current_user.id, fid)
    if not folder:
        raise HTTPException(404, "文件夹不存在")

    file_ids = await permanently_delete_folder(db, get_storage(), folder)
    await db.commit()
    for file_id in file_ids:
        delete_thumb_cache(file_id)
    await events.publish(current_user.id, "files", origin=origin)


# ── POST /trash/{fid}/restore ────────────────────────────────────────────────

@router.post("/{fid}/restore", status_code=204)
async def restore_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    try:
        restored = await restore_file_by_id(
            db, get_storage(), current_user.id, fid)
    except RestoreParentTrashError:
        raise HTTPException(409, "所属文件夹仍在回收站，请先恢复文件夹")
    if not restored:
        raise HTTPException(404, "文件不存在")
    await db.commit()
    await events.publish(current_user.id, "files", origin=origin)


# ── POST /trash/batch-restore ─────────────────────────────────────────────────

@router.post("/batch-restore", status_code=204)
async def batch_restore(
    body: BatchDeleteBody,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    if not body.ids:
        return
    try:
        await restore_files_by_ids(db, get_storage(), current_user.id, body.ids)
    except RestoreParentTrashError:
        raise HTTPException(409, "所属文件夹仍在回收站，请先恢复文件夹")
    await db.commit()
    await events.publish(current_user.id, "files", origin=origin)


# ── DELETE /trash/{fid} （永久删除单文件）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def hard_delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    deleted_id = await permanently_delete_file(
        db, get_storage(), current_user.id, fid)
    if deleted_id is None:
        raise HTTPException(404, "文件不存在")
    await db.commit()
    delete_thumb_cache(deleted_id)
    await events.publish(current_user.id, "files", origin=origin)


# ── DELETE /trash （清空回收站）──────────────────────────────────────────────

@router.delete("", status_code=204)
async def empty_trash(
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    roots = (await db.execute(top_level_deleted_folders_stmt(current_user.id))).scalars().all()
    fids = await empty_trash_service(db, get_storage(), current_user.id, roots)
    await db.commit()
    for fid in fids:
        delete_thumb_cache(fid)
    await events.publish(current_user.id, "files", origin=origin)


# ── 自动清理过期文件 + 文件夹（P2.5，由 main.py 在启动时调用）────────────────────

async def cleanup_expired(db: AsyncSession) -> int:
    """系统级任务，全局执行（无 user_id 过滤）。返回值口径不变：清理的过期**文件**数
    （沿用既有调用方日志文案）；过期文件夹的清理是内部同步动作，自己打日志，不进返回值。"""
    cutoff = now_utc() - timedelta(days=TRASH_DAYS)
    storage = get_storage()

    stmt = select(File).where(File.deleted_at.isnot(None), File.deleted_at <= cutoff)
    files = (await db.execute(stmt)).scalars().all()
    fids = [f.id for f in files]
    for f in files:
        try:
            await storage.delete(f.storage_key)
        except Exception:
            pass
        await db.delete(f)
    if files:
        await db.commit()
        for fid in fids:
            delete_thumb_cache(fid)

    # 过期文件夹（顶层已删、deleted_at 超过 30 天）：硬删 Folder 行——ORM cascade
    # （Folder.children，`all, delete-orphan`）连带删掉整棵子树；子树内文件已由上面那段按
    # 各自 deleted_at 清掉（同批软删的文件与文件夹共用同一时间戳，自然同批过期）。目录骨架的
    # 物理清理已在原删除那一刻尽力做过（P2.2 delete()），这里只做尽力而为的收尾重试。
    roots = (await db.execute(top_level_deleted_folders_stmt().where(
        Folder.deleted_at <= cutoff))).scalars().all()
    for root in roots:
        dir_key = await folder_dir_key(db, root.user_id, root)
        await db.delete(root)
        if dir_key:
            try:
                await storage.remove_folder(dir_key)
            except Exception:
                pass
    if roots:
        await db.commit()
        _log.info("回收站自动清理 %d 个过期文件夹", len(roots))

    return len(fids)
