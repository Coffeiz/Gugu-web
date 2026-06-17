from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import File, Project, Folder, User
from app.schemas import FileResponse, BatchDeleteBody
from app.core.security import get_current_user
from app.services.storage import get_storage
from app.api.v1.files import _to_resp, _color

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


# ── POST /trash/{fid}/restore ────────────────────────────────────────────────

@router.post("/{fid}/restore", status_code=204)
async def restore_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await db.get(File, fid)
    if not f or f.user_id != current_user.id or f.deleted_at is None:
        raise HTTPException(404, "文件不存在")
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
    await db.execute(
        sa_update(File)
        .where(File.id.in_(body.ids), File.user_id == current_user.id, File.deleted_at.isnot(None))
        .values(deleted_at=None)
    )
    await db.commit()


# ── DELETE /trash/{fid} （永久删除单文件）────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def hard_delete_file(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await db.get(File, fid)
    if not f or f.user_id != current_user.id or f.deleted_at is None:
        raise HTTPException(404, "文件不存在")
    try:
        await get_storage().delete(f.storage_key)
    except Exception:
        pass
    await db.delete(f)
    await db.commit()


# ── DELETE /trash （清空回收站）──────────────────────────────────────────────

@router.delete("", status_code=204)
async def empty_trash(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(File).where(File.user_id == current_user.id, File.deleted_at.isnot(None))
    files = (await db.execute(stmt)).scalars().all()
    storage = get_storage()
    for f in files:
        try:
            await storage.delete(f.storage_key)
        except Exception:
            pass
        await db.delete(f)
    await db.commit()


# ── 自动清理过期文件（由 main.py 在启动时调用）────────────────────────────────

async def cleanup_expired(db: AsyncSession) -> int:
    cutoff = datetime.utcnow() - timedelta(days=TRASH_DAYS)
    stmt = select(File).where(File.deleted_at.isnot(None), File.deleted_at <= cutoff)
    files = (await db.execute(stmt)).scalars().all()
    if not files:
        return 0
    storage = get_storage()
    for f in files:
        try:
            await storage.delete(f.storage_key)
        except Exception:
            pass
        await db.delete(f)
    await db.commit()
    return len(files)
