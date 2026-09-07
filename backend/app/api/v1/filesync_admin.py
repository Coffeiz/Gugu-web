"""文件同步 Admin 观测、对账和冲突恢复入口。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.db.session import get_db
from app.services.filesync.admin import (
    admin_dry_run_binding,
    admin_reconcile_binding,
    admin_resolve_conflict,
    get_admin_sync_status,
)

router = APIRouter(prefix="/admin/filesync", tags=["admin"])


class BindingActionRequest(BaseModel):
    confirm: bool = False
    allow_delete: bool = False


class ConflictActionRequest(BaseModel):
    resolution: Literal["keep_local", "keep_remote", "keep_both", "cancel"]
    confirm: bool = False


def _result(result):
    summary = result.summary
    return {
        "bindingId": result.binding_id,
        "mode": result.mode,
        "rootPath": result.root_path,
        "dryRun": result.dry_run,
        "summary": {
            "scanned": summary.scanned,
            "created": summary.created,
            "updated": summary.updated,
            "moved": summary.moved,
            "deleted": summary.deleted,
            "rejected": summary.rejected,
            "conflicts": summary.conflicts,
        },
        "conflictIds": list(result.conflict_ids),
    }


@router.get("/status")
async def sync_status(
    user_id: UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await get_admin_sync_status(db, user_id=user_id)


@router.post("/bindings/{binding_id}/dry-run")
async def binding_dry_run(binding_id: int, db: AsyncSession = Depends(get_db)):
    try:
        return _result(await admin_dry_run_binding(db, binding_id))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/bindings/{binding_id}/reconcile")
async def binding_reconcile(
    binding_id: int,
    body: BindingActionRequest,
    db: AsyncSession = Depends(get_db),
):
    if not body.confirm:
        raise HTTPException(status_code=400, detail="对账执行必须显式确认")
    if body.allow_delete:
        raise HTTPException(status_code=400, detail="删除同步对象请使用逐项恢复入口")
    try:
        return _result(await admin_reconcile_binding(db, binding_id, allow_delete=False))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/conflicts/{conflict_id}/resolve")
async def conflict_resolve(
    conflict_id: int,
    body: ConflictActionRequest,
    db: AsyncSession = Depends(get_db),
):
    if body.resolution != "cancel" and not body.confirm:
        raise HTTPException(status_code=400, detail="冲突恢复必须显式确认")
    try:
        row = await admin_resolve_conflict(db, conflict_id, body.resolution)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "id": row.id,
        "status": row.status,
        "resolution": row.resolution,
    }
