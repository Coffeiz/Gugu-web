"""日历事件查询与基础写入边界。"""
from sqlalchemy import select

from app.core.ownership import get_owned
from app.models import CalendarEvent, Project, ScheduledTask


async def create_event(db, user_id, *, title, date, time, end_time, event_type, project_id):
    if project_id is not None and not await get_owned(db, Project, project_id, user_id):
        return None
    event = CalendarEvent(
        user_id=user_id,
        title=title,
        date=date,
        time=time,
        end_time=end_time,
        type=event_type,
        project_id=project_id,
    )
    db.add(event)
    await db.flush()
    return event


async def list_events_with_reminders(db, user_id, *, start=None, end=None, event_type=None, limit=50):
    stmt = select(CalendarEvent).where(CalendarEvent.user_id == user_id)
    if start:
        stmt = stmt.where(CalendarEvent.date >= start)
    if end:
        stmt = stmt.where(CalendarEvent.date <= end)
    if event_type:
        stmt = stmt.where(CalendarEvent.type == event_type)
    events = (await db.execute(
        stmt.order_by(CalendarEvent.date).limit(limit)
    )).scalars().all()
    tasks = []
    if events:
        tasks = (await db.execute(
            select(ScheduledTask).where(
                ScheduledTask.user_id == user_id,
                ScheduledTask.event_id.in_([event.id for event in events]),
            ).order_by(ScheduledTask.id)
        )).scalars().all()
    by_event = {}
    for task in tasks:
        by_event.setdefault(task.event_id, []).append(task)
    return events, by_event


async def get_event(db, user_id, event_id):
    return await get_owned(db, CalendarEvent, event_id, user_id)


async def find_events_by_title(db, user_id, title: str):
    rows = (await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            CalendarEvent.title == title,
        )
    )).scalars().all()
    if not rows:
        rows = (await db.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == user_id,
                CalendarEvent.title.ilike(f"%{title}%"),
            )
        )).scalars().all()
    return rows


async def list_event_reminders(db, user_id, event_id):
    return (await db.execute(
        select(ScheduledTask).where(
            ScheduledTask.event_id == event_id,
            ScheduledTask.user_id == user_id,
        ).order_by(ScheduledTask.id)
    )).scalars().all()
