"""活动提醒幂等回归：重复提前量不能生成多条任务。"""
from sqlalchemy import select

from app.api.v1.scheduled_tasks import TaskCreate, create_task
from app.models import CalendarEvent, ScheduledTask
from app.services.calendar import create_event_reminders


async def _event(db, user):
    event = CalendarEvent(
        user_id=user.id,
        title="合成测试活动",
        date="2099-01-02",
        time="10:00",
        type="event",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def test_duplicate_leads_are_created_once(db, user_a):
    event = await _event(db, user_a)

    created, skipped = await create_event_reminders(db, user_a.id, event, [30, 30], ["web"])

    assert len(created) == 1
    assert any("重复" in message for message in skipped)
    rows = (await db.execute(select(ScheduledTask).where(ScheduledTask.event_id == event.id))).scalars().all()
    assert len(rows) == 1


async def test_repeated_add_for_same_fire_time_is_idempotent(db, user_a):
    event = await _event(db, user_a)

    first, _ = await create_event_reminders(db, user_a.id, event, [30], ["web"])
    second, skipped = await create_event_reminders(db, user_a.id, event, [30], ["web"])

    assert len(first) == 1
    assert second == []
    assert any("已存在" in message for message in skipped)
    rows = (await db.execute(select(ScheduledTask).where(ScheduledTask.event_id == event.id))).scalars().all()
    assert len(rows) == 1


async def test_scheduled_task_api_returns_existing_event_reminder(db, user_a):
    event = await _event(db, user_a)
    body = TaskCreate(
        name="合成测试活动提醒",
        payload="提醒合成测试活动",
        schedule_kind="once",
        start_at="2099-01-02T09:30:00",
        event_id=event.id,
    )

    first = await create_task(body, user_a, db)
    second = await create_task(body, user_a, db)

    assert first["id"] == second["id"]
    rows = (await db.execute(select(ScheduledTask).where(ScheduledTask.event_id == event.id))).scalars().all()
    assert len(rows) == 1
