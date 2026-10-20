"""Web 与 Agent 共享事件版本：旧草稿、读写交错及提醒事务不静默覆盖。"""
from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.tools import calendar as calendar_tools
from app.api.v1 import events as events_api
from app.core.schedule_rules import SCHEDULE_TZ
from app.core.tz import now_utc
from app.models import CalendarEvent, UndoOperation
from app.schemas import EventUpdate
from app.services.calendar import (
    list_event_reminders,
    replace_event_reminders,
    soft_delete_event_atomic,
    update_event_atomic,
)


async def _seed_event(db, user):
    event = CalendarEvent(user_id=user.id, title="原活动", date="2099-01-02", time="10:00", version=3)
    db.add(event)
    await db.flush()
    reminders, error = await replace_event_reminders(db, user.id, event, [
        {"lead_minutes": 30, "channels": ["web"]},
    ])
    assert error is None
    await db.commit()
    return event, reminders[0].id


async def _write(source, db, user, event_id, *, title, version=3, time="12:00"):
    if source == "agent":
        result = await calendar_tools._update_event(db, user.id, {
            "event_id": event_id, "title": title, "time": time,
        })
        if result.get("error"):
            return False
        await db.commit()
        return True
    try:
        await events_api.update_event(event_id, EventUpdate(title=title, time=time, version=version), user, db)
    except HTTPException as exc:
        assert exc.status_code == 409
        return False
    return True


async def _commit_competing_update(db, user, event_id, source, *, title="胜出的修改"):
    async with AsyncSession(bind=db.bind, expire_on_commit=False) as competitor:
        assert await _write(source, competitor, user, event_id, title=title)


@pytest.mark.asyncio
async def test_agent_write_invalidates_old_web_draft(db, user_a, monkeypatch):
    monkeypatch.setattr(events_api.events, "publish", AsyncMock())
    event, _ = await _seed_event(db, user_a)
    assert await _write("agent", db, user_a, event.id, title="Agent 修改")
    await db.refresh(event)
    assert event.version == 4
    assert not await _write("web", db, user_a, event.id, title="旧草稿", version=3)
    await db.refresh(event)
    assert event.title == "Agent 修改"
    assert event.version == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("loser", ["agent", "web"])
@pytest.mark.parametrize("winner", ["agent", "web"])
async def test_writer_loses_if_other_writer_commits_after_its_read(db, user_a, monkeypatch, loser, winner):
    """另一独立 Session 在读取和更新之间提交，双方都必须拒绝丢失更新。"""
    monkeypatch.setattr(events_api.events, "publish", AsyncMock())
    event, reminder_id = await _seed_event(db, user_a)
    event_id = event.id
    sync = AsyncMock(wraps=calendar_tools.sync_event_reminders_after_update)
    undo = AsyncMock(wraps=events_api.UndoService.record_forward)
    monkeypatch.setattr(calendar_tools, "sync_event_reminders_after_update", sync)
    monkeypatch.setattr(events_api, "sync_event_reminders_after_update", sync)
    monkeypatch.setattr(events_api.UndoService, "record_forward", undo)
    original_resolve = calendar_tools._resolve_event
    original_list = events_api.list_event_reminders
    raced = False

    async def competing_write():
        nonlocal raced
        if raced:
            return
        raced = True
        await _commit_competing_update(db, user_a, event_id, winner)

    async def resolve(session, *args, **kwargs):
        result = await original_resolve(session, *args, **kwargs)
        if session is db:
            await competing_write()
        return result

    async def reminders(session, *args, **kwargs):
        result = await original_list(session, *args, **kwargs)
        if session is db:
            await competing_write()
        return result

    if loser == "agent":
        monkeypatch.setattr(calendar_tools, "_resolve_event", resolve)
    else:
        monkeypatch.setattr(events_api, "list_event_reminders", reminders)

    assert not await _write(loser, db, user_a, event_id, title="不应覆盖", time="15:00")
    assert raced
    # 即使错误调用方误提交，也不应存在失败者留下的事件/提醒脏写。
    await db.commit()
    await db.refresh(event)
    assert (event.title, event.time, event.version) == ("胜出的修改", "12:00", 4)
    rows = await list_event_reminders(db, user_a.id, event_id)
    assert len(rows) == 1 and rows[0].id == reminder_id
    assert rows[0].name == "胜出的修改 提醒"
    assert rows[0].reminder_lead_minutes == 30
    assert rows[0].start_at == datetime(2099, 1, 2, 11, 30, tzinfo=SCHEDULE_TZ)
    assert sync.await_count == 1
    assert undo.await_count == int(winner == "web")
    assert events_api.events.publish.await_count == int(winner == "web")


@pytest.mark.asyncio
async def test_agent_reminder_only_update_also_advances_event_version(db, user_a):
    event, _ = await _seed_event(db, user_a)
    result = await calendar_tools._update_event(db, user_a.id, {"event_id": event.id, "reminders": []})
    assert result["success"]
    await db.commit()
    await db.refresh(event)
    assert event.version == 4
    assert await list_event_reminders(db, user_a.id, event.id) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["agent", "web"])
async def test_invalid_reminder_reschedule_rolls_back_event_and_version(db, user_a, monkeypatch, source):
    monkeypatch.setattr(events_api.events, "publish", AsyncMock())
    event, reminder_id = await _seed_event(db, user_a)
    event_id = event.id
    user_id = user_a.id
    if source == "agent":
        result = await calendar_tools._update_event(db, user_a.id, {
            "event_id": event_id, "date": "2000-01-01", "time": "12:00", "title": "无效修改",
        })
        assert "error" in result
    else:
        with pytest.raises(HTTPException) as error:
            await events_api.update_event(event_id, EventUpdate(date="2000-01-01", time="12:00", title="无效修改", version=3), user_a, db)
        assert error.value.status_code == 422
    # 与 get_db/工具 dispatch 的失败事务边界一致。
    await db.rollback()
    await db.refresh(event)
    assert (event.title, event.date, event.time, event.version) == ("原活动", "2099-01-02", "10:00", 3)
    rows = await list_event_reminders(db, user_id, event_id)
    assert len(rows) == 1 and rows[0].id == reminder_id
    assert rows[0].name == "原活动 提醒"
    assert rows[0].start_at == datetime(2099, 1, 2, 9, 30, tzinfo=SCHEDULE_TZ)


def test_web_event_update_requires_client_version():
    with pytest.raises(ValidationError):
        EventUpdate(title="缺版本")


@pytest.mark.asyncio
async def test_web_empty_update_does_not_advance_version_or_emit_side_effects(db, user_a, monkeypatch):
    monkeypatch.setattr(events_api.events, "publish", AsyncMock())
    event, _ = await _seed_event(db, user_a)
    response = await events_api.update_event(event.id, EventUpdate(version=3), user_a, db)
    assert response.version == 3 and response.title == "原活动"
    await db.refresh(event)
    assert event.version == 3 and event.title == "原活动"
    assert events_api.events.publish.await_count == 0
    operations = (await db.execute(select(UndoOperation).where(
        UndoOperation.user_id == user_a.id,
        UndoOperation.resource == "calendar",
        UndoOperation.action == "update",
    ))).scalars().all()
    assert operations == []


@pytest.mark.asyncio
@pytest.mark.parametrize("rejection", ["wrong-owner", "deleted", "stale-version", "missing"])
async def test_atomic_write_rejects_unowned_deleted_missing_or_stale_event(db, user_a, user_b, rejection):
    event, _ = await _seed_event(db, user_a)
    if rejection == "deleted":
        event.deleted_at = now_utc()
        await db.commit()
    assert not await update_event_atomic(
        db, event.id + 1000 if rejection == "missing" else event.id,
        user_b.id if rejection == "wrong-owner" else user_a.id,
        2 if rejection == "stale-version" else 3, {"title": "不能写入"},
    )
    await db.commit()
    await db.refresh(event)
    assert (event.title, event.version) == ("原活动", 3)


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["version", "user_id", "deleted_at"])
async def test_atomic_update_payload_cannot_override_ownership_or_version(db, user_a, field):
    event, _ = await _seed_event(db, user_a)
    with pytest.raises(ValueError, match="不支持的日历更新字段"):
        await update_event_atomic(db, event.id, user_a.id, 3, {field: None})
    await db.commit()
    await db.refresh(event)
    assert event.version == 3 and event.user_id == user_a.id and event.deleted_at is None


@pytest.mark.asyncio
async def test_web_delete_requires_matching_version_and_remains_undoable(db, user_a, monkeypatch):
    monkeypatch.setattr(events_api.events, "publish", AsyncMock())
    event, reminder_id = await _seed_event(db, user_a)
    request = type("RequestStub", (), {"headers": {"X-Undo-Context-ID": "web-delete-version", "X-Client-Id": "test"}})()

    with pytest.raises(HTTPException) as conflict:
        await events_api.delete_event(event.id, 2, user_a, db, request)
    assert conflict.value.status_code == 409

    await events_api.delete_event(event.id, 3, user_a, db, request)
    await db.refresh(event)
    assert event.deleted_at is not None and event.version == 4
    reminders = await list_event_reminders(db, user_a.id, event.id)
    assert len(reminders) == 1 and reminders[0].id == reminder_id and not reminders[0].enabled
    operation = (await db.execute(select(UndoOperation).where(
        UndoOperation.user_id == user_a.id,
        UndoOperation.undo_context_id == "web-delete-version",
        UndoOperation.resource == "calendar",
        UndoOperation.action == "delete",
    ))).scalar_one()
    assert operation.after_state["items"][f"event:{event.id}"]["version"] == 4


@pytest.mark.asyncio
async def test_web_soft_delete_rejects_update_committed_after_route_read(db, user_a, monkeypatch):
    monkeypatch.setattr(events_api.events, "publish", AsyncMock())
    event, reminder_id = await _seed_event(db, user_a)
    original_delete = soft_delete_event_atomic

    async def competing_soft_delete(session, event_id, owner_id, version, deleted_at):
        await _commit_competing_update(db, user_a, event_id, "agent", title="并发更新")
        return await original_delete(session, event_id, owner_id, version, deleted_at)

    monkeypatch.setattr(events_api, "soft_delete_event_atomic", competing_soft_delete)
    request = type("RequestStub", (), {"headers": {"X-Undo-Context-ID": "delete-race", "X-Client-Id": "test"}})()
    with pytest.raises(HTTPException) as conflict:
        await events_api.delete_event(event.id, 3, user_a, db, request)
    assert conflict.value.status_code == 409
    await db.commit()
    await db.refresh(event)
    assert (event.title, event.version, event.deleted_at) == ("并发更新", 4, None)
    assert events_api.events.publish.await_count == 0
    assert await db.scalar(select(UndoOperation.id).where(
        UndoOperation.user_id == user_a.id,
        UndoOperation.undo_context_id == "delete-race",
    )) is None
    reminders = await list_event_reminders(db, user_a.id, event.id)
    assert len(reminders) == 1 and reminders[0].id == reminder_id and reminders[0].enabled


@pytest.mark.asyncio
async def test_agent_soft_delete_rejects_event_changed_after_read(db, user_a, monkeypatch):
    event, reminder_id = await _seed_event(db, user_a)
    event_id, user_id = event.id, user_a.id
    monkeypatch.setattr(calendar_tools.confirm, "needs_target_confirmation", lambda *a, **k: None)
    original_delete = soft_delete_event_atomic

    async def competing_delete(session, *, event_id, user_id, client_version, deleted_at):
        await _commit_competing_update(db, user_a, event_id, "web", title="并发更新")
        return await original_delete(
            session, event_id, user_id, client_version, deleted_at,
        )

    monkeypatch.setattr(calendar_tools, "soft_delete_event_atomic", competing_delete)
    result = await calendar_tools._delete_event(db, user_id, {"event_id": event_id})
    assert result == {"error": "事件刚被其他端修改，未删除，请重试"}
    await db.commit()
    await db.refresh(event)
    assert (event.title, event.version, event.deleted_at) == ("并发更新", 4, None)
    reminders = await list_event_reminders(db, user_id, event_id)
    assert len(reminders) == 1 and reminders[0].id == reminder_id
