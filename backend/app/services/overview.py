"""总览聚合查询边界。"""
from sqlalchemy import func, select

from app.models import CalendarEvent, Client, File, Project


async def upcoming_rows(db, user_id, today, until):
    projects = (await db.execute(select(Project).where(
        Project.user_id == user_id, Project.archived.is_(False), Project.status != "done",
        Project.deadline.is_not(None), Project.deadline >= today, Project.deadline <= until,
    ))).scalars().all()
    events = (await db.execute(select(CalendarEvent).where(
        CalendarEvent.user_id == user_id, CalendarEvent.date >= today, CalendarEvent.date <= until,
    ))).scalars().all()
    return projects, events


async def dashboard_counts(db, user_id, today):
    async def count(stmt):
        return (await db.execute(stmt)).scalar() or 0
    base = select(func.count(Project.id)).where(Project.user_id == user_id, Project.archived.is_(False))
    return {
        "pending": await count(base.where(Project.status == "pending")),
        "active": await count(base.where(Project.status == "active")),
        "done": await count(base.where(Project.status == "done")),
        "upcoming_events": await count(select(func.count(CalendarEvent.id)).where(CalendarEvent.user_id == user_id, CalendarEvent.date >= today)),
        "files": await count(select(func.count(File.id)).where(File.user_id == user_id, File.deleted_at.is_(None))),
        "clients": await count(select(func.count(Client.id)).where(Client.user_id == user_id)),
    }
