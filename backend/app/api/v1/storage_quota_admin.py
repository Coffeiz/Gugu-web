"""Admin 手动触发全量存储配额对账。"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from app.core import redis as R
from app.core.redaction import diag_log
from app.services.storage.quota_periodic import (
    _LOCK_KEY,
    _LOCK_TTL_SECONDS,
    _renew_scheduler_lock,
    reconcile_due_storage_users,
)

router = APIRouter(prefix="/admin/storage-quota", tags=["admin"])
_STATE_KEY = "storage:quota_reconcile:manual_state"
_STATE_TTL_SECONDS = 7 * 24 * 60 * 60
_tasks: set[asyncio.Task] = set()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _save_state(redis, state: dict) -> None:
    await redis.set(
        _STATE_KEY,
        json.dumps(state, ensure_ascii=False),
        ex=_STATE_TTL_SECONDS,
    )


async def _read_state(redis) -> dict:
    raw = await redis.get(_STATE_KEY)
    if not raw:
        return {"status": "idle"}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {"status": "idle"}
    return value if isinstance(value, dict) else {"status": "idle"}


async def _run_full_reconcile(lock, redis, state: dict) -> None:
    stop_event = asyncio.Event()
    lease_lost = asyncio.Event()
    renew_task = asyncio.create_task(
        _renew_scheduler_lock(lock, stop_event, lease_lost),
    )
    try:
        state.update(status="running", started_at=_utc_now())
        await _save_state(redis, state)

        async def report_progress(progress: dict[str, int]) -> None:
            state.update(progress, updated_at=_utc_now())
            await _save_state(redis, state)

        import app.db.session as db_session

        db_session.ensure_engine()
        await reconcile_due_storage_users(
            db_session._SessionLocal,
            stop_event=lease_lost,
            include_all_users=True,
            progress_callback=report_progress,
        )
        state.update(
            status="completed" if not lease_lost.is_set() else "interrupted",
            finished_at=_utc_now(),
        )
        await _save_state(redis, state)
    except asyncio.CancelledError:
        state.update(status="interrupted", finished_at=_utc_now())
        await _save_state(redis, state)
        raise
    except Exception as exc:
        diag_log("storage.quota_manual_reconcile", exc)
        state.update(status="failed", finished_at=_utc_now())
        await _save_state(redis, state)
    finally:
        stop_event.set()
        renew_task.cancel()
        await asyncio.gather(renew_task, return_exceptions=True)
        try:
            await lock.release()
        except Exception as exc:
            diag_log("storage.quota_manual_reconcile_lock_release", exc)


@router.post("/reconcile")
async def start_full_reconcile():
    redis = R.get_redis()
    lock = redis.lock(_LOCK_KEY, timeout=_LOCK_TTL_SECONDS, blocking=False)
    try:
        acquired = await lock.acquire(blocking=False)
    except Exception as exc:
        diag_log("storage.quota_manual_reconcile_lock", exc)
        raise HTTPException(status_code=503, detail="暂时无法启动对账") from exc
    if not acquired:
        state = await _read_state(redis)
        if state.get("status") not in {"queued", "running"}:
            state = {"status": "busy"}
        return {"started": False, "state": state}

    state = {
        "status": "queued", "total": 0, "processed": 0,
        "completed": 0, "failed": 0, "started_at": None,
    }
    try:
        await _save_state(redis, state)
        task = asyncio.create_task(_run_full_reconcile(lock, redis, state))
    except Exception as exc:
        try:
            await lock.release()
        except Exception:
            pass
        diag_log("storage.quota_manual_reconcile_start", exc)
        raise HTTPException(status_code=503, detail="暂时无法启动对账") from exc
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"started": True, "state": state}


@router.get("/reconcile")
async def get_full_reconcile_status():
    try:
        redis = R.get_redis()
        state = await _read_state(redis)
        if state.get("status") in {"queued", "running"} and not await redis.exists(_LOCK_KEY):
            state.update(status="interrupted", finished_at=_utc_now())
            await _save_state(redis, state)
        return state
    except Exception as exc:
        diag_log("storage.quota_manual_reconcile_status", exc)
        raise HTTPException(status_code=503, detail="暂时无法读取对账状态") from exc
