"""本地文件同步 API；OSS 模式只返回拒绝，不暴露伪造的目录状态。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User
from app.schemas import CamelModel
from app.services.filesync import (
    FileSyncMode,
    dry_run_local_binding,
    get_user_binding,
    list_user_bindings,
    list_user_conflicts,
    resolve_sync_conflict,
    sync_local_binding,
    enqueue_file_event,
    deliver_file_event,
)

router = APIRouter(prefix="/filesync", tags=["filesync"])


class BindingRequest(CamelModel):
    root_path: str = Field(default=".", min_length=1, max_length=1000)
    mode: str = FileSyncMode.BIDIRECTIONAL
    confirm: bool = False
    confirm_delete: bool = False


class ReconcileRequest(CamelModel):
    allow_delete: bool = False


class ConflictResolutionRequest(CamelModel):
    resolution: str


def _summary(result):
    summary = result.summary
    return {
        "scanned": summary.scanned,
        "created": summary.created,
        "updated": summary.updated,
        "moved": summary.moved,
        "deleted": summary.deleted,
        "rejected": summary.rejected,
        "conflicts": summary.conflicts,
    }


def _result(result):
    return {
        "bindingId": result.binding_id,
        "mode": result.mode,
        "rootPath": result.root_path,
        "dryRun": result.dry_run,
        "summary": _summary(result),
        "conflictIds": list(result.conflict_ids),
    }


async def _queue_sync_event(db, user_id, result, *, source: str = "local_directory"):
    summary = result.summary
    if not any((summary.created, summary.updated, summary.moved, summary.deleted, summary.conflicts)):
        return None
    return await enqueue_file_event(
        db, user_id,
        operation="refresh",
        entity_ids=summary.entity_ids,
        source=source,
    )


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


@router.post("/dry-run")
async def dry_run(body: BindingRequest, user: User = Depends(get_current_user), db=Depends(get_db)):
    try:
        result = await dry_run_local_binding(db, user.id, root_path=body.root_path, mode=body.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _result(result)


@router.post("/bindings")
async def create_or_reconcile_binding(
    body: BindingRequest, user: User = Depends(get_current_user), db=Depends(get_db),
):
    try:
        if not body.confirm:
            result = await dry_run_local_binding(
                db, user.id, root_path=body.root_path, mode=body.mode,
            )
        else:
            result = await sync_local_binding(
                db, user.id, root_path=body.root_path, mode=body.mode,
                allow_delete=body.confirm_delete,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.confirm:
        outbox = await _queue_sync_event(db, user.id, result)
        await db.commit()
        if outbox is not None:
            await deliver_file_event(db, outbox)
            await db.commit()
    return _result(result)


@router.post("/bindings/{binding_id}/reconcile")
async def reconcile_binding(
    binding_id: int, body: ReconcileRequest,
    user: User = Depends(get_current_user), db=Depends(get_db),
):
    binding = await get_user_binding(db, user.id, binding_id)
    if binding is None or binding.source != "local_directory":
        raise HTTPException(status_code=404, detail="同步绑定不存在")
    try:
        result = await sync_local_binding(
            db, user.id, root_path=binding.root_path, mode=binding.mode,
            allow_delete=body.allow_delete,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    outbox = await _queue_sync_event(db, user.id, result)
    await db.commit()
    if outbox is not None:
        await deliver_file_event(db, outbox)
        await db.commit()
    return _result(result)


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
