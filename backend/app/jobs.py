"""定时任务的纯查询辅助（任务本体已 DB 化，见 app/scheduled_tasks.py）。

`scan_upcoming_deadlines` 被 deadline_scan 动作 + 总览面板复用。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select


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
