"""本地文件同步 API；OSS 模式只返回拒绝，不暴露伪造的目录状态。"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User
from app.models import FileSyncBinding, FileSyncReconcileRun
from app.schemas import CamelModel
from app.services.filesync import (
    FileSyncMode,
    get_user_binding,
    list_user_bindings,
    list_user_conflicts,
    resolve_sync_conflict,
    is_file_sync_enabled,
)
from app.services.filesync.jobs import enqueue_reconcile, request_job_cancel
from app.services.filesync.job_api import reconcile_run_result
from app.services.filesync.bindings import _get_or_create_binding, resolve_local_binding_root
from app.services.workspaces import workspace_shell_supported
from sqlalchemy import select

router = APIRouter(prefix="/filesync", tags=["filesync"])


class BindingRequest(CamelModel):
    root_path: str = Field(default=".", min_length=1, max_length=1000)
    mode: str = FileSyncMode.BIDIRECTIONAL
    confirm: bool = False
    confirm_delete: bool = False
    integrity_full: bool = False


class ReconcileRequest(CamelModel):
    allow_delete: bool = False
    integrity_full: bool = False


class ConflictResolutionRequest(CamelModel):
    resolution: str


async def _enqueue_path_binding_run(
    db, user: User, body: BindingRequest, *, dry_run: bool, allow_delete: bool,
):
    root_path, root = resolve_local_binding_root(user.id, body.root_path)
    binding = await _get_or_create_binding(
        db, user.id, root_path=root_path, root=root, mode=body.mode,
    )
    mode = "integrity_full" if body.integrity_full or not binding.baseline_generation else "snapshot_diff"
    return await enqueue_reconcile(
        db, binding, mode=mode, reason="manual",
        dry_run=dry_run, allow_delete=allow_delete,
    )


async def _request_path_binding_run(
    db, user: User, body: BindingRequest, *, dry_run: bool, allow_delete: bool,
):
    if body.mode not in {item.value for item in FileSyncMode}:
        raise HTTPException(status_code=400, detail="同步模式无效")
    if not is_file_sync_enabled() or not workspace_shell_supported():
        raise HTTPException(status_code=400, detail="当前存储模式不支持本地文件同步")
    try:
        row = await _enqueue_path_binding_run(
            db, user, body, dry_run=dry_run, allow_delete=allow_delete,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    return reconcile_run_result(row)


@router.get("/bindings")
async def bindings(user: User = Depends(get_current_user), db=Depends(get_db)):
    rows = await list_user_bindings(db, user.id)
    return [{
        "id": row.id,
        "source": row.source,
        "mode": row.mode,
        "rootPath": row.root_path,
        "status": row.status,
        "revision": row.revision,
        "lastReconciledAt": row.last_reconciled_at.isoformat() if row.last_reconciled_at else None,
    } for row in rows]


@router.post("/dry-run", status_code=status.HTTP_202_ACCEPTED)
async def dry_run(body: BindingRequest, user: User = Depends(get_current_user), db=Depends(get_db)):
    return await _request_path_binding_run(
        db, user, body, dry_run=True, allow_delete=False,
    )


@router.post("/bindings", status_code=status.HTTP_202_ACCEPTED)
async def create_or_reconcile_binding(
    body: BindingRequest,
    user: User = Depends(get_current_user), db=Depends(get_db),
):
    return await _request_path_binding_run(
        db, user, body, dry_run=not body.confirm,
        allow_delete=body.confirm and body.confirm_delete,
    )


@router.post("/bindings/{binding_id}/reconcile", status_code=status.HTTP_202_ACCEPTED)
async def reconcile_binding(
    binding_id: int, body: ReconcileRequest,
    user: User = Depends(get_current_user), db=Depends(get_db),
):
    binding = await get_user_binding(db, user.id, binding_id)
    if binding is None or binding.source != "local_directory":
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    if binding.status != "active":
        raise HTTPException(status_code=409, detail="同步绑定已解绑")
    row = await enqueue_reconcile(
        db, binding,
        mode=("integrity_full" if body.integrity_full or not binding.baseline_generation else "snapshot_diff"),
        reason="manual", allow_delete=body.allow_delete,
    )
    await db.commit()
    return reconcile_run_result(row)


@router.get("/jobs/{run_id}")
async def get_reconcile_job(
    run_id: str, user: User = Depends(get_current_user), db=Depends(get_db),
):
    try:
        job_id = UUID(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="对账任务不存在") from exc
    row = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.id == job_id,
        FileSyncReconcileRun.user_id == user.id,
    ))
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    return reconcile_run_result(row)


@router.post("/jobs/{run_id}/cancel", status_code=status.HTTP_202_ACCEPTED)
async def cancel_reconcile_job(
    run_id: str,
    user: User = Depends(get_current_user), db=Depends(get_db),
):
    try:
        job_id = UUID(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="对账任务不存在") from exc
    row = await request_job_cancel(db, user_id=user.id, run_id=job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    await db.commit()
    return reconcile_run_result(row)


@router.get("/conflicts")
async def conflicts(user: User = Depends(get_current_user), db=Depends(get_db)):
    rows = await list_user_conflicts(db, user.id)
    return [{
        "id": row.id,
        "bindingId": row.binding_id,
        "relativePath": row.relative_path,
        "baselineFingerprint": row.baseline_fingerprint,
        "localFingerprint": row.local_fingerprint,
        "remoteFingerprint": row.remote_fingerprint,
        "status": row.status,
        "createdAt": row.created_at.isoformat(),
    } for row in rows]


@router.post("/conflicts/{conflict_id}/resolve")
async def resolve_conflict(
    conflict_id: int, body: ConflictResolutionRequest,
    user: User = Depends(get_current_user), db=Depends(get_db),
):
    try:
        row = await resolve_sync_conflict(db, user.id, conflict_id, body.resolution)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    outbox = await enqueue_file_event(
        db, user.id, operation="refresh", source="local_directory",
        entity_ids=(),
    )
    await db.commit()
    await deliver_file_event(db, outbox)
    await db.commit()
    return {"id": row.id, "status": row.status, "resolution": row.resolution}
