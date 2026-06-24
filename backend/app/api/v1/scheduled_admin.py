"""Admin：系统级定时任务配置（启用 / 时间）。

系统任务 = `scheduled_tasks` 里 `user_id` 为空的（如「截稿临近扫描」，跨所有用户跑）。
这里只动系统任务；用户自己的任务在用户「定时任务」页管。鉴权由 main.py 的 require_admin 兜。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import ScheduledTask

router = APIRouter(prefix="/admin/scheduled-tasks", tags=["admin"])


def _validate_cron(cron: str) -> None:
    from apscheduler.triggers.cron import CronTrigger
    try:
        CronTrigger.from_crontab(cron)
    except Exception:
        raise HTTPException(400, f"cron 非法：{cron!r}")


def _resp(t: ScheduledTask) -> dict:
    return {
        "id": t.id, "name": t.name, "action_type": t.action_type, "cron": t.cron,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
    }


class SysUpdate(BaseModel):
    enabled: bool | None = None
    cron: str | None = None
    name: str | None = None
    channels: list[str] | None = None


async def _sys_task(tid: int, db: AsyncSession) -> ScheduledTask:
    t = await db.get(ScheduledTask, tid)
    if not t or t.user_id is not None:
        raise HTTPException(404, "系统任务不存在")
    return t


@router.get("")
async def list_system(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.user_id.is_(None)).order_by(ScheduledTask.id)
    )).scalars().all()
    ucount = (await db.execute(
        select(func.count(ScheduledTask.id)).where(ScheduledTask.user_id.is_not(None))
    )).scalar() or 0
    return {"system": [_resp(t) for t in rows], "user_task_count": ucount}


@router.patch("/{tid}")
async def update_system(tid: int, body: SysUpdate, db: AsyncSession = Depends(get_db)):
    t = await _sys_task(tid, db)
    if body.cron is not None:
        _validate_cron(body.cron)
        t.cron = body.cron
    if body.enabled is not None:
        t.enabled = body.enabled
    if body.name is not None:
        t.name = body.name
    if body.channels is not None:
        chs = [c for c in body.channels if c in ("chat", "im")]
        t.channels = ",".join(chs) if chs else "chat"
    await db.commit()
    await db.refresh(t)
    return _resp(t)


@router.post("/{tid}/run")
async def run_system(tid: int, db: AsyncSession = Depends(get_db)):
    await _sys_task(tid, db)
    from app import scheduled_tasks as ST
    await ST.execute_task(tid)
    return {"ok": True, "msg": "已执行一次（按各用户开关投递）"}
