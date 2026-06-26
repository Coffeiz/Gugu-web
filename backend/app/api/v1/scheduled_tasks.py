"""用户定时任务 API：列表 / 增删改 / 立即试运行。

任务由 worker 每 ~30s 从 DB reconcile 到 APScheduler（新建/改动最多 30s 后生效）；
「立即运行」直接在本进程执行一次，便于测试。系统级任务（user_id 空）不在此暴露。
到点统一交给 agent 执行 payload（指令），无 reminder/agent 之分。
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

_CHANNELS = {"web", "feishu", "qq", "im", "chat"}   # web=站内通知、feishu/qq=各 IM；chat=web、im=全部 IM（历史别名）


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
    return ",".join(chs) if chs else "web"


def _to_resp(t: ScheduledTask) -> dict:
    return {
        "id": t.id, "name": t.name,
        "payload": t.payload, "cron": t.cron,
        "channels": [c for c in (t.channels or "").split(",") if c],
        "enabled": t.enabled,
        "last_run_at": t.last_run_at.isoformat() if t.last_run_at else None,
    }


class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    payload: str = ""         # 到点要执行的指令
    cron: str                 # crontab "分 时 日 月 周"，或 @once:<ISO>
    channels: list[str] = ["web"]
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
    _validate_cron(body.cron)
    t = ScheduledTask(
        user_id=user.id, name=body.name,
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
    """立即试运行一次并等结果，返回各渠道投递状态（成功 / 无地址 / 失败）给用户看。

    试运行是手动操作、用户在等反馈，所以同步 await（连接池已够，不会像 SSE 那样耗尽）。
    """
    await _owned(task_id, user, db)
    from app import scheduled_tasks as ST
    result = await ST.execute_task(task_id, is_trial=True)
    if not result:
        return {"ok": True, "msg": "已执行（该任务未选任何投递渠道）"}
    msg = "试运行结果：\n" + "\n".join(f"· {k}：{v}" for k, v in result.items())
    return {"ok": True, "result": result, "msg": msg}
