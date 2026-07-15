import logging
from datetime import datetime, timedelta
from app.core.tz import now_utc

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func, or_
from sqlalchemy.orm import aliased
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
from app.core.ownership import get_owned
from app.core import events
from app.services.files.trash import (
    RestoreParentTrashError,
    permanently_delete_file,
    restore_file_by_id,
)
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
        .where(
            File.user_id == current_user.id,
            File.deleted_at.isnot(None),
            # 文件夹作为整体恢复单元时，内部文件不应再以独立条目出现；否则用户可以把
            # 文件恢复到仍被软删的父目录里，得到数据库指向已删文件夹的“幽灵文件”。
            or_(File.folder_id.is_(None), Folder.deleted_at.is_(None)),
        )
        .order_by(File.deleted_at.desc())
    )
    result = await db.execute(stmt)
    return [_to_resp(f, pname, _color(pcolor), fname) for f, pname, pcolor, fname in result.all()]


async def _ensure_file_parent_is_live(f: File, db: AsyncSession) -> None:
    """拒绝把仍归属回收站文件夹的文件单独恢复。"""
    if f.folder_id is None:
        return
    folder = await get_owned(db, Folder, f.folder_id, f.user_id)
    if not folder or folder.deleted_at is not None:
        raise HTTPException(409, "所属文件夹仍在回收站，请先恢复文件夹")


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


@router.get("/folders/{fid}/contents", response_model=TrashFolderContentsResponse)
async def list_trash_folder_contents(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取顶层回收站文件夹的直属内容，内部文件不作为独立恢复单元。"""
    folder = (await db.execute(
        _top_level_deleted_folders_stmt(current_user.id).where(Folder.id == fid)
    )).scalar_one_or_none()
    if not folder:
        raise HTTPException(404, "文件夹不存在")
    child_folders = (await db.execute(
        select(Folder).where(
            Folder.user_id == current_user.id,
            Folder.parent_id == folder.id,
            Folder.deleted_at.isnot(None),
        ).order_by(Folder.deleted_at.desc())
    )).scalars().all()
    direct_files = (await db.execute(
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.user_id == current_user.id,
            File.folder_id == folder.id,
            File.deleted_at.isnot(None),
        ).order_by(File.deleted_at.desc())
    )).all()
    if child_folders:
        counts_res = await db.execute(
            select(File.folder_id, func.count().label("cnt"))
            .where(File.folder_id.in_([f.id for f in child_folders]), File.deleted_at.isnot(None))
            .group_by(File.folder_id)
        )
        count_map = {row.folder_id: row.cnt for row in counts_res}
    else:
        count_map = {}
    return TrashFolderContentsResponse(
        folders=[TrashFolderResponse(
            id=f.id, project_id=f.project_id, parent_id=f.parent_id, name=f.name,
            file_count=count_map.get(f.id, 0), version=f.version,
            deleted_at=f.deleted_at.strftime("%Y-%m-%dT%H:%M:%S"),
        ) for f in child_folders],
        files=[_to_resp(f, pname, _color(pcolor), fname)
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


async def _deleted_folder_subtree_ids(folder: Folder, db: AsyncSession) -> list[int]:
    """返回回收站文件夹的整棵已删子树，供永久删除一次性清理。"""
    ids = [folder.id]
    frontier = [folder.id]
    while frontier:
        children = (await db.execute(
            select(Folder.id).where(
                Folder.user_id == folder.user_id,
                Folder.parent_id.in_(frontier),
                Folder.deleted_at.isnot(None),
            )
        )).scalars().all()
        ids.extend(children)
        frontier = children
    return ids


# ── DELETE /trash/folders/{fid} （永久删除顶层文件夹）──────────────────────────

@router.delete("/folders/{fid}", status_code=204)
async def hard_delete_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    # 只允许删除回收站中可见的顶层恢复单元，避免绕开父文件夹删掉子树中的一个节点。
    folder = (await db.execute(
        _top_level_deleted_folders_stmt(current_user.id).where(Folder.id == fid)
    )).scalar_one_or_none()
    if not folder:
        raise HTTPException(404, "文件夹不存在")

    folder_ids = await _deleted_folder_subtree_ids(folder, db)
    files = (await db.execute(
        select(File).where(
            File.user_id == current_user.id,
            File.folder_id.in_(folder_ids),
            File.deleted_at.isnot(None),
        )
    )).scalars().all()
    storage = get_storage()
    file_ids = [f.id for f in files]
    for f in files:
        try:
            await storage.delete(f.storage_key)
        except Exception:
            pass
        await db.delete(f)

    dir_key = await folder_dir_key(db, folder.user_id, folder)
    await db.delete(folder)
    if dir_key:
        try:
            await storage.remove_folder(dir_key)
        except Exception:
            pass
    await db.commit()
    for file_id in file_ids:
        _delete_thumb_cache(file_id)
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
    stmt = select(File).where(
        File.id.in_(body.ids),
        File.user_id == current_user.id,
        File.deleted_at.isnot(None),
    )
    files = (await db.execute(stmt)).scalars().all()
    for f in files:
        await _ensure_file_parent_is_live(f, db)
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
    deleted_id = await permanently_delete_file(
        db, get_storage(), current_user.id, fid)
    if deleted_id is None:
        raise HTTPException(404, "文件不存在")
    await db.commit()
    _delete_thumb_cache(deleted_id)
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
    roots = (await db.execute(_top_level_deleted_folders_stmt(current_user.id))).scalars().all()
    for root in roots:
        dir_key = await folder_dir_key(db, root.user_id, root)
        await db.delete(root)
        if dir_key:
            try:
                await storage.remove_folder(dir_key)
            except Exception:
                pass
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
