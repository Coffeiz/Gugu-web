"""本地文件同步 API；OSS 模式只返回拒绝，不暴露伪造的目录状态。"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User
from app.schemas import CamelModel
from app.services.filesync import (
    FileSyncMode,
    get_user_binding,
    list_user_bindings,
    list_user_conflicts,
    resolve_sync_conflict,
    prepare_local_binding,
    ReconcileRunError,
    enqueue_reconcile_run,
    get_reconcile_run,
    list_reconcile_runs,
    request_run_cancel,
    serialize_reconcile_run,
    notify_run_changed,
)

router = APIRouter(prefix="/filesync", tags=["filesync"])


class BindingRequest(CamelModel):
    root_path: str = Field(default=".", min_length=1, max_length=1000)
    mode: str = FileSyncMode.BIDIRECTIONAL
    confirm: bool = False
    confirm_delete: bool = False


class ReconcileRequest(CamelModel):
    confirm: bool = False
    allow_delete: bool = False


class ConflictResolutionRequest(CamelModel):
    resolution: str


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
        "watcherStatus": row.watcher_status,
        "needsReconcile": row.needs_reconcile,
        "healthRevision": row.health_revision,
        "gapRevision": row.gap_revision,
        "healthErrorCode": row.health_error_code,
        "lastReconciledAt": row.last_reconciled_at.isoformat() if row.last_reconciled_at else None,
    } for row in rows]


@router.post("/dry-run")
async def dry_run(body: BindingRequest, user: User = Depends(get_current_user), db=Depends(get_db)):
    try:
        binding = await prepare_local_binding(
            db, user.id, root_path=body.root_path, mode=body.mode,
        )
        run = await enqueue_reconcile_run(
            db, user_id=user.id, binding_id=binding.id, action="dry_run",
        )
        await db.commit()
        await notify_run_changed(run)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReconcileRunError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return serialize_reconcile_run(run)


@router.post("/bindings")
async def create_or_reconcile_binding(
    body: BindingRequest, user: User = Depends(get_current_user), db=Depends(get_db),
):
    try:
        binding = await prepare_local_binding(
            db, user.id, root_path=body.root_path, mode=body.mode,
        )
        action = "dry_run" if not body.confirm else (
            "initialize" if binding.last_reconciled_at is None else "repair"
        )
        run = await enqueue_reconcile_run(
            db, user_id=user.id, binding_id=binding.id, action=action,
            allow_delete=bool(body.confirm and body.confirm_delete),
        )
        await db.commit()
        await notify_run_changed(run)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReconcileRunError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return serialize_reconcile_run(run)


@router.post("/bindings/{binding_id}/reconcile")
async def reconcile_binding(
    binding_id: int, body: ReconcileRequest,
    user: User = Depends(get_current_user), db=Depends(get_db),
):
    if not body.confirm:
        raise HTTPException(status_code=400, detail="对账执行必须显式确认")
    binding = await get_user_binding(db, user.id, binding_id)
    if binding is None or binding.source != "local_directory":
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    try:
        run = await enqueue_reconcile_run(
            db, user_id=user.id, binding_id=binding.id, action="repair",
            allow_delete=body.allow_delete,
        )
        await db.commit()
        await notify_run_changed(run)
    except ReconcileRunError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return serialize_reconcile_run(run)


@router.get("/runs")
async def runs(
    binding_id: int | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    rows = await list_reconcile_runs(
        db, user_id=user.id, binding_id=binding_id, limit=limit,
    )
    return [serialize_reconcile_run(row) for row in rows]


@router.get("/runs/{run_id}")
async def run_status(
    run_id: UUID, user: User = Depends(get_current_user), db=Depends(get_db),
):
    row = await get_reconcile_run(db, run_id, user_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    return serialize_reconcile_run(row)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(
    run_id: UUID, user: User = Depends(get_current_user), db=Depends(get_db),
):
    row = await request_run_cancel(db, run_id, user_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="对账任务不存在")
    await db.commit()
    await notify_run_changed(row)
    return serialize_reconcile_run(row)


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
