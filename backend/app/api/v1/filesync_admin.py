"""文件同步 Admin 观测、对账和冲突恢复入口。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from sqlalchemy import select
from app.models import FileSyncBinding, FileSyncReconcileRun
from app.services.filesync.jobs import enqueue_reconcile, request_job_cancel
from app.services.filesync.job_api import reconcile_run_result
from app.services.workspaces import workspace_shell_supported

from app.db.session import get_db
from app.services.filesync.admin import (
    admin_resolve_conflict,
    get_admin_sync_status,
)
from app.services.filesync.bindings import unbind_file_sync

router = APIRouter(prefix="/admin/filesync", tags=["admin"])


class BindingActionRequest(BaseModel):
    confirm: bool = False
    allow_delete: bool = False
    integrity_full: bool = False


class ConflictActionRequest(BaseModel):
    resolution: Literal["keep_local", "keep_remote", "keep_both", "cancel"]
    confirm: bool = False


async def _enqueue_admin_binding_run(
    db: AsyncSession,
    binding: FileSyncBinding,
    *,
    integrity_full: bool,
    dry_run: bool,
):
    if not workspace_shell_supported():
        raise HTTPException(status_code=400, detail="当前存储模式不支持本地文件同步")
    mode = "integrity_full" if integrity_full or not binding.baseline_generation else "snapshot_diff"
    return await enqueue_reconcile(
        db, binding, mode=mode, reason="manual",
        dry_run=dry_run, allow_delete=False,
    )


@router.get("/status")
async def sync_status(
    user_id: UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await get_admin_sync_status(db, user_id=user_id)


@router.post("/bindings/{binding_id}/dry-run", status_code=status.HTTP_202_ACCEPTED)
async def binding_dry_run(
    binding_id: int,
    body: BindingActionRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    binding = await db.get(FileSyncBinding, binding_id)  # ownership-exempt: require_admin 保护且管理员可跨用户操作。
    if binding is None:
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    if binding.status != "active":
        raise HTTPException(status_code=409, detail="同步绑定已解绑")
    row = await _enqueue_admin_binding_run(
        db, binding, integrity_full=bool(body and body.integrity_full), dry_run=True,
    )
    await db.commit()
    return reconcile_run_result(row, include_admin_fields=True)


@router.post("/bindings/{binding_id}/reconcile", status_code=status.HTTP_202_ACCEPTED)
async def binding_reconcile(
    binding_id: int,
    body: BindingActionRequest,
    db: AsyncSession = Depends(get_db),
):
    if not body.confirm:
        raise HTTPException(status_code=400, detail="对账执行必须显式确认")
    if body.allow_delete:
        raise HTTPException(status_code=400, detail="删除同步对象请使用逐项恢复入口")
    binding = await db.get(FileSyncBinding, binding_id)  # ownership-exempt: require_admin 保护且管理员可跨用户操作。
    if binding is None:
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    if binding.status != "active":
        raise HTTPException(status_code=409, detail="同步绑定已解绑")
    row = await _enqueue_admin_binding_run(
        db, binding, integrity_full=body.integrity_full, dry_run=False,
    )
    await db.commit()
    return reconcile_run_result(row, include_admin_fields=True)


@router.delete("/bindings/{binding_id}")
async def binding_unbind(
    binding_id: int,
    body: BindingActionRequest,
    db: AsyncSession = Depends(get_db),
):
    if not body.confirm:
        raise HTTPException(status_code=400, detail="解绑必须显式确认")
    binding = await unbind_file_sync(db, binding_id)
    if binding is None:
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    await db.commit()
    return {"id": binding.id, "status": binding.status, "scopeRevision": binding.scope_revision}


@router.get("/runs/{run_id}")
async def reconcile_run_status(run_id: UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(FileSyncReconcileRun, run_id)  # ownership-exempt: require_admin 保护且管理员可跨用户查看。
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    return reconcile_run_result(row, include_admin_fields=True)


@router.post("/runs/{run_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
async def cancel_reconcile_run(
    run_id: UUID, response: Response, db: AsyncSession = Depends(get_db),
):
    row = await request_job_cancel(db, user_id=None, run_id=run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    await db.commit()
    response.status_code = status.HTTP_202_ACCEPTED
    return reconcile_run_result(row, include_admin_fields=True)


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
