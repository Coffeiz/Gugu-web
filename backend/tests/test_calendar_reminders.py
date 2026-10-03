"""活动提醒聚合回归：重复配置拒绝写入，完整替换保持幂等。"""
from sqlalchemy import select

from app.api.v1.scheduled_tasks import TaskCreate, create_task
from app.models import CalendarEvent, ScheduledTask
from app.services.calendar import replace_event_reminders


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


async def test_duplicate_leads_are_rejected_without_partial_write(db, user_a):
    event = await _event(db, user_a)

    created, error = await replace_event_reminders(db, user_a.id, event, [
        {"lead_minutes": 30, "channels": ["web"]},
        {"lead_minutes": 30, "channels": ["qq"]},
    ])

    assert created is None
    assert "重复" in error
    rows = (await db.execute(select(ScheduledTask).where(ScheduledTask.event_id == event.id))).scalars().all()
    assert rows == []


async def test_repeated_add_for_same_fire_time_is_idempotent(db, user_a):
    event = await _event(db, user_a)

    config = [{"lead_minutes": 30, "channels": ["web"]}]
    first, error = await replace_event_reminders(db, user_a.id, event, config)
    second, error = await replace_event_reminders(db, user_a.id, event, config)

    assert len(first) == 1
    assert error is None
    assert len(second) == 1 and second[0].id == first[0].id
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
