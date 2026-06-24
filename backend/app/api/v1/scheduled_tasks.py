"""用户定时任务 API：列表 / 增删改 / 立即试运行 + 内置提醒开关。

任务由 worker 每 ~30s 从 DB reconcile 到 APScheduler（新建/改动最多 30s 后生效）；
「立即运行」直接在本进程执行一次，便于测试。系统级任务（user_id 空）不在此暴露。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import ScheduledTask, User

router = APIRouter(prefix="/scheduled-tasks", tags=["scheduled-tasks"])

_ACTIONS = {"reminder", "agent"}        # 用户能建的动作（系统级 deadline_scan 不开放）
_CHANNELS = {"chat", "im"}


def _validate_cron(cron: str) -> None:
    if (cron or "").startswith("@once:"):
        from datetime import datetime
        try:
            datetime.fromisoformat(cron[6:])
        except ValueError:
            raise HTTPException(400, "一次性时间格式错误")
        return
    from apscheduler.triggers.cron import CronTrigger
    try:
        CronTrigger.from_crontab(cron)
    except Exception:
        raise HTTPException(400, f"cron 表达式非法：{cron!r}（格式 “分 时 日 月 周”，如 0 9 * * *）")


def _norm_channels(chs: list[str] | None) -> str:
    chs = [c for c in (chs or []) if c in _CHANNELS]
    return ",".join(chs) if chs else "chat"


def _to_resp(t: ScheduledTask) -> dict:
    return {
        "id": t.id, "name": t.name, "action_type": t.action_type,
        "payload": t.payload, "cron": t.cron,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
    }


class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    action_type: str          # reminder | agent
    payload: str = ""
    cron: str                 # crontab "分 时 日 月 周"
    channels: list[str] = ["chat"]
    enabled: bool = True


class TaskUpdate(BaseModel):
    name: str | None = None
    payload: str | None = None
    cron: str | None = None
    channels: list[str] | None = None
    enabled: bool | None = None


@router.get("")
async def list_tasks(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.user_id == user.id).order_by(ScheduledTask.id.desc())
    )).scalars().all()
    return {"tasks": [_to_resp(t) for t in rows]}


@router.post("", status_code=201)
async def create_task(body: TaskCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if body.action_type not in _ACTIONS:
        raise HTTPException(400, f"action_type 只能是 {_ACTIONS}")
    _validate_cron(body.cron)
    t = ScheduledTask(
        user_id=user.id, name=body.name, action_type=body.action_type,
        payload=body.payload or "", cron=body.cron,
        channels=_norm_channels(body.channels), enabled=body.enabled,
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return _to_resp(t)


async def _owned(task_id: int, user: User, db: AsyncSession) -> ScheduledTask:
    t = await db.get(ScheduledTask, task_id)
    if not t or t.user_id != user.id:
        raise HTTPException(404, "任务不存在")
    return t


@router.patch("/{task_id}")
async def update_task(task_id: int, body: TaskUpdate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    t = await _owned(task_id, user, db)
    if body.cron is not None:
        _validate_cron(body.cron)
        t.cron = body.cron
    if body.name is not None:
        t.name = body.name
    if body.payload is not None:
        t.payload = body.payload
    if body.channels is not None:
        t.channels = _norm_channels(body.channels)
    if body.enabled is not None:
        t.enabled = body.enabled
    await db.commit()
    await db.refresh(t)
    return _to_resp(t)


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    t = await _owned(task_id, user, db)
    await db.delete(t)
    await db.commit()


@router.post("/{task_id}/run")
async def run_now(task_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """立即执行一次（试运行）。直接在本进程跑，不等 worker。"""
    await _owned(task_id, user, db)
    from app import scheduled_tasks as ST
    await ST.execute_task(task_id)
    return {"ok": True, "msg": "已执行一次，去「⏰ 咕咕提醒」会话看结果"}
