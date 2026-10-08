"""文件同步 Admin 观测、对账和冲突恢复入口。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.db.session import get_db
from app.models import FileSyncBinding
from app.services.filesync.admin import admin_resolve_conflict, get_admin_sync_status
from app.services.filesync.jobs import (
    ReconcileRunError,
    enqueue_reconcile_run,
    get_reconcile_run,
    list_reconcile_runs,
    request_run_cancel,
    serialize_reconcile_run,
    notify_run_changed,
)
from app.services.workspaces import workspace_shell_supported
from app.core.events import FILESYNC_ADMIN_CHANNEL
from app.api.v1.live import event_stream_response
from sqlalchemy import select

router = APIRouter(prefix="/admin/filesync", tags=["admin"])


@router.get("/events")
async def filesync_admin_events(request: Request):
    """受 main.py Admin 鉴权保护的绑定/任务失效通知流。"""
    return event_stream_response(request, channels=(FILESYNC_ADMIN_CHANNEL,))


class BindingActionRequest(BaseModel):
    confirm: bool = False
    allow_delete: bool = False


class ConflictActionRequest(BaseModel):
    resolution: Literal["keep_local", "keep_remote", "keep_both", "cancel"]
    confirm: bool = False


@router.get("/status")
async def sync_status(
    user_id: UUID | None = Query(None),
    conflict_limit: int = Query(100, ge=1, le=5000),
    db: AsyncSession = Depends(get_db),
):
    return await get_admin_sync_status(db, user_id=user_id, conflict_limit=conflict_limit)


@router.post("/bindings/{binding_id}/dry-run")
async def binding_dry_run(binding_id: int, db: AsyncSession = Depends(get_db)):
    try:
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.id == binding_id,
        ))
        if binding is None:
            raise LookupError("同步绑定不存在")
        run = await enqueue_reconcile_run(
            db, user_id=binding.user_id, binding_id=binding.id, action="dry_run",
        )
        await db.commit()
        await notify_run_changed(run)
        return serialize_reconcile_run(run)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReconcileRunError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
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
        binding = await db.scalar(select(FileSyncBinding).where(
            FileSyncBinding.id == binding_id,
        ))
        if binding is None:
            raise LookupError("同步绑定不存在")
        run = await enqueue_reconcile_run(
            db, user_id=binding.user_id, binding_id=binding.id, action="repair",
        )
        await db.commit()
        await notify_run_changed(run)
        return serialize_reconcile_run(run)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReconcileRunError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reconcile-issues")
async def reconcile_issue_bindings(
    body: BindingActionRequest,
    db: AsyncSession = Depends(get_db),
):
    """批量排入非破坏性修复核对。"""
    from app.core.config import get_settings

    if not body.confirm:
        raise HTTPException(status_code=400, detail="批量对账必须显式确认")
    if body.allow_delete:
        raise HTTPException(status_code=400, detail="批量对账不允许删除文件库记录")
    if get_settings().storage.backend != "local" or not workspace_shell_supported():
        raise HTTPException(status_code=400, detail="当前存储模式不支持本地文件同步")

    snapshot = await get_admin_sync_status(db)
    issue_binding_ids = [
        item["id"] for item in snapshot["bindings"]
        if item["pendingJournal"] > 0
        or item["failedJournal"] > 0
        or item["rejectedJournal"] > 0
        or item["pendingConflicts"] > 0
        or item["needsReconcile"]
        or item["watcherStatus"] not in {"ready", "inactive", "unknown"}
    ]
    bindings = list((await db.scalars(
        select(FileSyncBinding)
        .where(
            FileSyncBinding.id.in_(issue_binding_ids),
            FileSyncBinding.source == "local_directory",
            FileSyncBinding.status == "active",
            FileSyncBinding.mode != "mirror_out",
        )
        .order_by(FileSyncBinding.id)
    )).all())
    result = {
        "eligible": len(bindings),
        "queued": 0,
        "busy": 0,
        "skipped": 0,
    }
    changed_runs = []
    for binding in bindings:
        try:
            run = await enqueue_reconcile_run(
                db,
                user_id=binding.user_id,
                binding_id=binding.id,
                action="repair",
                allow_delete=False,
            )
        except LookupError:
            result["skipped"] += 1
            continue
        except ReconcileRunError:
            result["busy"] += 1
            continue
        result["queued"] += 1
        changed_runs.append(run)

    await db.commit()
    for run in changed_runs:
        await notify_run_changed(run)
    return result


@router.post("/bindings/{binding_id}/initialize")
async def binding_initialize(
    binding_id: int,
    body: BindingActionRequest,
    db: AsyncSession = Depends(get_db),
):
    if not body.confirm:
        raise HTTPException(status_code=400, detail="初始化必须显式确认")
    if body.allow_delete:
        raise HTTPException(status_code=400, detail="初始化不能删除文件库记录")
    binding = await db.scalar(select(FileSyncBinding).where(
        FileSyncBinding.id == binding_id,
    ))
    if binding is None:
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    try:
        run = await enqueue_reconcile_run(
            db, user_id=binding.user_id, binding_id=binding.id, action="initialize",
        )
        await db.commit()
        await notify_run_changed(run)
    except ReconcileRunError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return serialize_reconcile_run(run)


@router.get("/runs")
async def runs(
    user_id: UUID | None = Query(None),
    binding_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    rows = await list_reconcile_runs(
        db, user_id=user_id, binding_id=binding_id, limit=limit,
    )
    return [serialize_reconcile_run(row) for row in rows]


@router.get("/runs/{run_id}")
async def run_status(run_id: UUID, db: AsyncSession = Depends(get_db)):
    row = await get_reconcile_run(db, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    return serialize_reconcile_run(row)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: UUID, db: AsyncSession = Depends(get_db)):
    row = await request_run_cancel(db, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    await db.commit()
    await notify_run_changed(row)
    return serialize_reconcile_run(row)


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
