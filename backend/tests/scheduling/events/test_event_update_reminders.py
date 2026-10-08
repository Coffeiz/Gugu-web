"""保护 Web 事件编辑与活动提醒、撤销/重做的一致性。"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.api.v1.events import update_event
from app.models import CalendarEvent, UndoOperation
from app.schemas import EventUpdate
from app.services.calendar import list_event_reminders, replace_event_reminders
from app.services.undo import UndoService


@pytest.mark.asyncio
async def test_web_event_update_reschedules_reminders_and_undo_redo_restores_them(db, user_a):
    event = CalendarEvent(
        user_id=user_a.id, title="旧标题", date="2099-01-02", time="10:00", version=1,
    )
    db.add(event)
    await db.flush()
    reminders, error = await replace_event_reminders(db, user_a.id, event, [
        {"lead_minutes": 30, "channels": ["web"]},
        {"lead_minutes": 150, "channels": ["qq"]},
        {"lead_minutes": 60, "channels": ["web"], "enabled": False},
    ])
    assert error is None
    await db.commit()
    before = {row.id: (row.cron, row.start_at, row.reminder_lead_minutes) for row in reminders}
    disabled = next(row for row in reminders if not row.enabled)
    disabled_id = disabled.id
    request = SimpleNamespace(headers={
        "X-Undo-Context-ID": "calendar-event-reminder-roundtrip",
        "X-Client-Id": "calendar-test",
    })

    await update_event(
        event.id,
        EventUpdate(title="新标题", time="12:00"),
        user_a,
        db,
        request,
    )
    await db.commit()
    await db.refresh(event)
    after_rows = await list_event_reminders(db, user_a.id, event.id)
    after = {row.id: (row.cron, row.start_at, row.reminder_lead_minutes) for row in after_rows}

    assert event.time == "12:00"
    assert {row.id for row in after_rows} == set(before)
    assert after[disabled_id] == before[disabled_id]
    assert all(row.name == "新标题 提醒" and "新标题" in row.payload for row in after_rows)
    assert after[next(row.id for row in reminders if row.enabled and row.reminder_lead_minutes == 30)][0] != before[
        next(row.id for row in reminders if row.enabled and row.reminder_lead_minutes == 30)
    ][0]

    operation = (await db.execute(select(UndoOperation).where(
        UndoOperation.user_id == user_a.id,
        UndoOperation.undo_context_id == "calendar-event-reminder-roundtrip",
        UndoOperation.action == "update",
    ))).scalar_one()
    await UndoService.apply(
        db, user_id=user_a.id, context_id="calendar-event-reminder-roundtrip",
        operation_id=operation.id, mode="undo",
    )
    await db.commit()
    await db.refresh(event)
    undone_rows = await list_event_reminders(db, user_a.id, event.id)
    assert event.time == "10:00"
    assert {row.id: (row.cron, row.start_at, row.reminder_lead_minutes) for row in undone_rows} == before
    assert all(row.name == "旧标题 提醒" and "旧标题" in row.payload for row in undone_rows)

    await UndoService.apply(
        db, user_id=user_a.id, context_id="calendar-event-reminder-roundtrip",
        operation_id=operation.id, mode="redo",
    )
    await db.commit()
    await db.refresh(event)
    redone_rows = await list_event_reminders(db, user_a.id, event.id)
    assert event.time == "12:00"
    assert {row.id: (row.cron, row.start_at, row.reminder_lead_minutes) for row in redone_rows} == after
    assert all(row.name == "新标题 提醒" and "新标题" in row.payload for row in redone_rows)
