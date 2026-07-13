import logging
from datetime import datetime, timedelta
from app.core.tz import now_utc

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Project, Folder, User
from app.schemas import FileResponse, FolderResponse, TrashFolderResponse, BatchDeleteBody
from app.core.security import get_current_user, get_client_id
from app.core.ownership import get_owned
from app.core import events
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.storage.folders import folder_dir_key
from app.api.v1.files import _to_resp, _color, _delete_thumb_cache
from app.services.storage.trash import restore_file_storage

router = APIRouter(prefix="/trash", tags=["trash"])

TRASH_DAYS = 30
_log = logging.getLogger("app.api.v1.trash")


def _top_level_deleted_folders_stmt(user_id=None):
    """顶层已删文件夹（可整体恢复的单元）：自身已删 且（无父 或 父未删）——
    父已删说明本节点是被祖先那次删除连带扫入的，不单独列为回收站条目。
    user_id=None → 不限用户（cleanup_expired 全局清理任务用）；否则限定该用户（回收站列表用）。"""
    ParentFolder = aliased(Folder)
    stmt = (
        select(Folder)
        .outerjoin(ParentFolder, Folder.parent_id == ParentFolder.id)
        .where(
            Folder.deleted_at.isnot(None),
            (Folder.parent_id.is_(None)) | (ParentFolder.deleted_at.is_(None)),
        )
    )
    if user_id is not None:
        stmt = stmt.where(Folder.user_id == user_id)
    return stmt.order_by(Folder.deleted_at.desc())


# ── GET /trash ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[FileResponse])
async def list_trash(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(File.user_id == current_user.id, File.deleted_at.isnot(None))
        .order_by(File.deleted_at.desc())
    )
    result = await db.execute(stmt)
    return [_to_resp(f, pname, _color(pcolor), fname) for f, pname, pcolor, fname in result.all()]


# ── GET /trash/folders （P2.3：顶层已删文件夹）───────────────────────────────

@router.get("/folders", response_model=list[TrashFolderResponse])
async def list_trash_folders(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folders = (await db.execute(_top_level_deleted_folders_stmt(current_user.id))).scalars().all()
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


# ── POST /trash/{fid}/restore ────────────────────────────────────────────────

@router.post("/{fid}/restore", status_code=204)
async def restore_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at is None:
        raise HTTPException(404, "文件不存在")
    await restore_file_storage(f, get_storage(), db)
    f.deleted_at = None
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
    stmt = select(File).where(
        File.id.in_(body.ids),
        File.user_id == current_user.id,
        File.deleted_at.isnot(None),
    )
    files = (await db.execute(stmt)).scalars().all()
    storage = get_storage()
    for f in files:
        await restore_file_storage(f, storage, db)
        f.deleted_at = None
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
    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at is None:
        raise HTTPException(404, "文件不存在")
    fid = f.id
    try:
        await get_storage().delete(f.storage_key)
    except Exception:
        pass
    await db.delete(f)
    await db.commit()
    _delete_thumb_cache(fid)
    await events.publish(current_user.id, "files", origin=origin)


# ── DELETE /trash （清空回收站）──────────────────────────────────────────────

@router.delete("", status_code=204)
async def empty_trash(
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(File).where(File.user_id == current_user.id, File.deleted_at.isnot(None))
    files = (await db.execute(stmt)).scalars().all()
    storage = get_storage()
    fids = [f.id for f in files]
    for f in files:
        try:
            await storage.delete(f.storage_key)
        except Exception:
            pass
        await db.delete(f)
    await db.commit()
    for fid in fids:
        _delete_thumb_cache(fid)
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
            _delete_thumb_cache(fid)

    # 过期文件夹（顶层已删、deleted_at 超过 30 天）：硬删 Folder 行——ORM cascade
    # （Folder.children，`all, delete-orphan`）连带删掉整棵子树；子树内文件已由上面那段按
    # 各自 deleted_at 清掉（同批软删的文件与文件夹共用同一时间戳，自然同批过期）。目录骨架的
    # 物理清理已在原删除那一刻尽力做过（P2.2 delete()），这里只做尽力而为的收尾重试。
    roots = (await db.execute(_top_level_deleted_folders_stmt().where(
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
