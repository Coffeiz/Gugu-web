"""定时任务定义。

worker 进程 `import app.jobs` → 触发下面的 `@sched.register` → `scheduler.start()` 挂载。
新增定时任务：在这里加个 `@sched.register(...)` 的 async 函数即可。

> 主动 DM 推送目前是 **dry-run（只打日志）**——真往用户 IM 推还需要：
>   1. IM 寻址（按 user_id 反查其 平台/chat_id/openid，存一份「可触达地址」）
>   2.「何时打扰 / 多久一次 / 去重」策略
> 这两步留作下一步（主动触达功能），定时引擎本身先就位。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select

from app.core import scheduler as sched


async def scan_upcoming_deadlines(within_days: int = 2) -> list[dict]:
    """跨所有用户扫「近期截止的未完成项目」。纯查询、无副作用，供提醒/面板复用。"""
    import app.db.session as s
    from app.models import Project
    if s._engine is None:
        s._build_engine()
    today = datetime.now().strftime("%Y-%m-%d")
    until = (datetime.now() + timedelta(days=within_days)).strftime("%Y-%m-%d")
    async with s._SessionLocal() as db:
        rows = (await db.execute(
            select(Project).where(
                Project.deadline.is_not(None),
                Project.deadline >= today,        # String(10) ISO 日期，字典序比较即日期比较
                Project.deadline <= until,
                Project.status != "done",
                Project.archived.is_(False),
            ).order_by(Project.deadline)
        )).scalars().all()
    out: list[dict] = []
    for p in rows:
        try:
            days_left = (datetime.strptime(p.deadline, "%Y-%m-%d")
                         - datetime.strptime(today, "%Y-%m-%d")).days
        except ValueError:
            days_left = None
        out.append({"user_id": str(p.user_id), "project_id": p.id,
                    "name": p.name, "deadline": p.deadline, "days_left": days_left})
    return out


@sched.register(sched.cron(hour=9, minute=0), id="deadline_scan", name="截稿临近扫描")
async def deadline_scan() -> None:
    """每天 09:00 扫 48h 内到期的未完成项目。当前 dry-run：只打日志（推送下一步接）。"""
    try:
        candidates = await scan_upcoming_deadlines(within_days=2)
    except Exception as e:
        print(f"[job:deadline_scan] 扫描出错: {type(e).__name__}: {e}", flush=True)
        return
    if not candidates:
        print("[job:deadline_scan] 无 48h 内到期项目", flush=True)
        return
    print(f"[job:deadline_scan] {len(candidates)} 个项目临近截稿（dry-run，未推送）：", flush=True)
    for c in candidates:
        print(f"  · 用户 {c['user_id'][:8]} 项目「{c['name']}」距截稿 {c['days_left']} 天（{c['deadline']}）", flush=True)
