"""日历事件、提醒查询与写入边界。"""
from datetime import timedelta

from sqlalchemy import select

from app.core.ownership import get_owned
from app.core.tz import local_now
from app.models import CalendarEvent, Project, ScheduledTask

_REMINDER_CHANNELS = {"web", "feishu", "qq", "wechat"}


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


def normalize_reminder_channels(channels):
    channels = [c for c in (channels or ["web"]) if c in _REMINDER_CHANNELS]
    return ",".join(channels) if channels else "web"


def event_base_datetime(event):
    """返回事件开始的本地 naive datetime；全天事件按当天 09:00 计算。"""
    from datetime import datetime

    hh, mm = (event.time or "09:00").split(":")
    return datetime.fromisoformat(f"{event.date}T{int(hh):02d}:{int(mm):02d}:00")


def build_reminder(user_id, event, lead_minutes, channels):
    """构造一条绑定事件的提醒，不写库；返回 (task, error)。"""
    try:
        lead_minutes = int(lead_minutes)
    except (TypeError, ValueError):
        return None, "lead_minutes 需为整数分钟（0=活动开始时）"
    if lead_minutes < 0:
        return None, "lead_minutes 不能为负"
    fire = event_base_datetime(event) - timedelta(minutes=lead_minutes)
    if fire <= local_now().replace(tzinfo=None):
        return None, f"提前 {lead_minutes} 分钟（{fire.strftime('%Y-%m-%d %H:%M')}）已过，跳过"
    when = event.date + (f" {event.time}" if event.time else "")
    return ScheduledTask(
        user_id=user_id,
        name=f"{event.title} 提醒",
        payload=f"提醒：{event.title}（{when}）",
        cron=f"@once:{fire.strftime('%Y-%m-%dT%H:%M')}",
        channels=normalize_reminder_channels(channels),
        enabled=True,
        event_id=event.id,
    ), None


async def create_event_reminders(db, user_id, event, leads, channels):
    """批量创建事件提醒并提交，返回 (tasks, skipped_messages)。"""
    created, skipped = [], []
    for lead in leads:
        task, error = build_reminder(user_id, event, lead, channels)
        if error:
            skipped.append(error)
        else:
            db.add(task)
            created.append(task)
    await db.commit()
    for task in created:
        await db.refresh(task)
    return created, skipped


async def delete_event_with_reminders(db, user_id, event):
    """删除事件及其提醒，返回删除的提醒数量。"""
    reminders = await list_event_reminders(db, user_id, event.id)
    for reminder in reminders:
        await db.delete(reminder)
    await db.delete(event)
    await db.commit()
    return len(reminders)


async def get_event_reminder(db, user_id, reminder_id):
    reminder = await get_owned(db, ScheduledTask, reminder_id, user_id)
    if not reminder or reminder.event_id is None:
        return None
    return reminder


async def delete_event_reminder(db, user_id, reminder_id):
    reminder = await get_event_reminder(db, user_id, reminder_id)
    if reminder is None:
        return None
    reminder_id = reminder.id
    await db.delete(reminder)
    await db.commit()
    return reminder_id
