from datetime import datetime, timedelta
from app.core.tz import now_utc

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, MindMap, Project, Folder, User
from app.schemas import FileResponse, BatchDeleteBody
from app.core.security import get_current_user
from app.core.ownership import get_owned
from app.services.storage import get_storage
from app.api.v1.files import _to_resp, _color, _delete_thumb_cache, _build_key, _resolve_conflict

router = APIRouter(prefix="/trash", tags=["trash"])

TRASH_DAYS = 30


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


# ── 还原辅助：把物理文件从回收站移回原目录 ────────────────────────────────────

async def _restore_file_storage(f: File, db: AsyncSession) -> None:
    """重建原始 storage_key，将文件移回原目录；冲突时自动加 (n) 后缀。"""
    from app.services.storage import get_storage
    storage = get_storage()

    # 获取所属项目/文件夹/思维导图信息，重建原始路径（f 已归属校验；其所属对象按不变量应同属 f 的主人，
    # 用 f.user_id 走归属强制——万一数据串了宁可当"不存在"回根目录，也不读到别人的名字）
    project_name = project_year = project_month = folder_name = mind_map_title = ""
    if f.project_id:
        p = await get_owned(db, Project, f.project_id, f.user_id)
        if p:
            project_name = p.name
            date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
    if f.folder_id:
        fo = await get_owned(db, Folder, f.folder_id, f.user_id)
        if fo:
            folder_name = fo.name
    if f.mind_map_id:
        mm = await get_owned(db, MindMap, f.mind_map_id, f.user_id)
        if mm:
            mind_map_title = mm.title

    base_key = _build_key(
        uid=f.user_id, space=f.space,
        display_name=f.display_name, ext=f.ext,
        project_name=project_name, project_id=f.project_id or 0,
        project_year=project_year, project_month=project_month,
        folder_name=folder_name,
        mind_map_title=mind_map_title, mind_map_id=f.mind_map_id or 0,
    )
    final_key, final_name = await _resolve_conflict(storage, base_key, f.display_name, f.ext)

    old_key = f.storage_key
    try:
        await storage.rename_file(old_key, final_key)
        f.storage_key = final_key
        f.display_name = final_name
    except Exception:
        # 物理文件丢失时仍恢复 DB 记录，storage_key 重置为预期路径
        f.storage_key = final_key
        f.display_name = final_name


# ── POST /trash/{fid}/restore ────────────────────────────────────────────────

@router.post("/{fid}/restore", status_code=204)
async def restore_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await get_owned(db, File, fid, current_user.id)
    if not f or f.deleted_at is None:
        raise HTTPException(404, "文件不存在")
    await _restore_file_storage(f, db)
    f.deleted_at = None
    await db.commit()


# ── POST /trash/batch-restore ─────────────────────────────────────────────────

@router.post("/batch-restore", status_code=204)
async def batch_restore(
    body: BatchDeleteBody,
    current_user: User = Depends(get_current_user),
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
        await _restore_file_storage(f, db)
        f.deleted_at = None
    await db.commit()


# ── DELETE /trash/{fid} （永久删除单文件）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def hard_delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
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


# ── DELETE /trash （清空回收站）──────────────────────────────────────────────

@router.delete("", status_code=204)
async def empty_trash(
    current_user: User = Depends(get_current_user),
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


# ── 自动清理过期文件（由 main.py 在启动时调用）────────────────────────────────

async def cleanup_expired(db: AsyncSession) -> int:
    # 系统级任务，遍历所有用户的过期回收站文件，设计上是全局执行，无需 user_id 过滤
    cutoff = now_utc() - timedelta(days=TRASH_DAYS)
    stmt = select(File).where(File.deleted_at.isnot(None), File.deleted_at <= cutoff)
    files = (await db.execute(stmt)).scalars().all()
    if not files:
        return 0
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
    return len(fids)
