"""日历事件、提醒查询与写入边界。"""
from datetime import timedelta, timezone

from sqlalchemy import select

from app.core.ownership import get_owned
from app.core.schedule_rules import SCHEDULE_TZ
from app.core.tz import local_now
from app.models import CalendarEvent, Project, ScheduledTask

_REMINDER_CHANNELS = {"web", "feishu", "qq", "wechat"}


async def create_event(db, user_id, *, title, date, time, end_time, event_type, project_id):
    project = await get_owned(db, Project, project_id, user_id) if project_id is not None else None
    if project_id is not None and (project is None or project.deleted_at is not None):
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
    stmt = select(CalendarEvent).where(CalendarEvent.user_id == user_id, CalendarEvent.deleted_at.is_(None))
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
    event = await get_owned(db, CalendarEvent, event_id, user_id)
    return event if event and event.deleted_at is None else None


async def get_project(db, user_id, project_id):
    project = await get_owned(db, Project, project_id, user_id)
    return project if project and project.deleted_at is None else None


async def find_events_by_title(db, user_id, title: str):
    rows = (await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.title == title,
        )
    )).scalars().all()
    if not rows:
        rows = (await db.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == user_id,
                CalendarEvent.deleted_at.is_(None),
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


async def find_event_reminder_by_cron(db, user_id, event_id, cron, *, exclude_id=None):
    """查找活动在指定触发时刻的提醒，供 API 幂等处理重复提交。"""
    stmt = select(ScheduledTask).where(
        ScheduledTask.user_id == user_id,
        ScheduledTask.event_id == event_id,
        ScheduledTask.cron == cron,
    )
    if exclude_id is not None:
        stmt = stmt.where(ScheduledTask.id != exclude_id)
    return (await db.execute(stmt)).scalars().first()


def normalize_reminder_channels(channels):
    channels = list(dict.fromkeys(c for c in (channels or ["web"]) if c in _REMINDER_CHANNELS))
    return ",".join(channels) if channels else "web"


def event_base_datetime(event):
    """返回事件开始的本地 naive datetime；全天事件按当天 09:00 计算。"""
    from datetime import datetime

    hh, mm = (event.time or "09:00").split(":")
    return datetime.fromisoformat(f"{event.date}T{int(hh):02d}:{int(mm):02d}:00")


def build_reminder(user_id, event, lead_minutes, channels, delivery_targets=None, *, enabled=True):
    """构造一条绑定事件的提醒，不写库；返回 (task, error)。"""
    try:
        lead_minutes = int(lead_minutes)
    except (TypeError, ValueError):
        return None, "lead_minutes 需为整数分钟（0=活动开始时）"
    if lead_minutes < 0:
        return None, "lead_minutes 不能为负"
    fire = event_base_datetime(event) - timedelta(minutes=lead_minutes)
    if enabled and fire <= local_now().replace(tzinfo=None):
        return None, f"提前 {lead_minutes} 分钟（{fire.strftime('%Y-%m-%d %H:%M')}）已过，跳过"
    when = event.date + (f" {event.time}" if event.time else "")
    start_at = fire.replace(tzinfo=SCHEDULE_TZ)
    return ScheduledTask(
        user_id=user_id,
        name=f"{event.title} 提醒",
        payload=f"提醒：{event.title}（{when}）",
        cron=f"@once:{start_at.astimezone(timezone.utc).isoformat()}",
        schedule_kind="once",
        start_at=start_at,
        channels=normalize_reminder_channels(channels),
        enabled=enabled,
        event_id=event.id,
        reminder_lead_minutes=lead_minutes,
        delivery_targets=delivery_targets,
    ), None


def event_reminder_lead_minutes(task, base):
    """优先读取提醒配置；旧记录按尚未修改的活动时间推导。"""
    if task.reminder_lead_minutes is not None:
        return task.reminder_lead_minutes
    if task.schedule_kind != "once" or task.start_at is None:
        return None
    fire = task.start_at
    if fire.tzinfo is not None:
        fire = fire.astimezone(SCHEDULE_TZ).replace(tzinfo=None)
    return round((base - fire).total_seconds() / 60)


async def replace_event_reminders(db, user_id, event, reminders, *, preserve_disabled=False):
    """按活动的完整提醒字段对账，失败时在写库前返回错误。"""
    candidates = {}
    for reminder in reminders:
        task, error = build_reminder(
            user_id,
            event,
            reminder["lead_minutes"],
            reminder.get("channels"),
            reminder.get("delivery_targets"),
            enabled=reminder.get("enabled", True),
        )
        if error:
            return None, error
        if task.cron in candidates:
            return None, "reminders 中存在相同的触发时刻，请删除重复项"
        candidates[task.cron] = task

    existing = await list_event_reminders(db, user_id, event.id)
    by_cron = {task.cron: task for task in existing if not (preserve_disabled and not task.enabled)}
    preserved_disabled = [task for task in existing if preserve_disabled and not task.enabled]
    matched = []

    # 先删掉不再属于活动字段的提醒并 flush，避免触发 event + fire 唯一索引冲突。
    for task in by_cron.values():
        if task.cron not in candidates:
            await db.delete(task)
    await db.flush()

    for cron, candidate in candidates.items():
        current = by_cron.get(cron)
        if current is None:
            db.add(candidate)
            matched.append(candidate)
            continue
        current.name = candidate.name
        current.payload = candidate.payload
        current.schedule_kind = candidate.schedule_kind
        current.start_at = candidate.start_at
        current.channels = candidate.channels
        current.delivery_targets = candidate.delivery_targets
        current.enabled = candidate.enabled
        current.reminder_lead_minutes = candidate.reminder_lead_minutes
        matched.append(current)

    await db.flush()
    return [*matched, *preserved_disabled], None


async def refresh_event_reminder_metadata(db, user_id, event):
    """活动标题更新后同步提醒任务的人类可读标题和正文。"""
    when = event.date + (f" {event.time}" if event.time else "")
    reminders = await list_event_reminders(db, user_id, event.id)
    for reminder in reminders:
        reminder.name = f"{event.title} 提醒"
        reminder.payload = f"提醒：{event.title}（{when}）"
    await db.flush()
    return reminders


async def delete_event_with_reminders(db, user_id, event, *, commit=False):
    """删除事件及其提醒；默认只 flush，由 API/任务边界提交。"""
    reminders = await list_event_reminders(db, user_id, event.id)
    for reminder in reminders:
        await db.delete(reminder)
    await db.delete(event)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return len(reminders)
