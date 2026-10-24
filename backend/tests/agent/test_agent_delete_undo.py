"""Agent 删除可在原会话撤销，并与 Web 撤销栈隔离。"""
import pytest
from sqlalchemy import select

from agent.tools import calendar as calendar_tools
from agent.tools import projects as project_tools
from agent.tools.base import reset_dispatch_session, set_dispatch_session
from app.models import Project, UndoOperation
from app.services.calendar import create_event
from app.services.undo.agent import undo_latest_agent_action
from app.services.undo.service import UndoService


@pytest.mark.asyncio
async def test_agent_project_delete_is_undoable_only_in_its_session(db, user_a, monkeypatch):
    project = Project(user_id=user_a.id, name="待恢复项目", stages_json="[]", version=1)
    db.add(project)
    await db.commit()
    project_id = project.id
    monkeypatch.setattr(project_tools.confirm, "needs_target_confirmation", lambda *a, **k: None)
    token = set_dispatch_session(910, run_id="run-910", tool_call_id="delete-project")
    try:
        deleted = await project_tools._delete_project(db, user_a.id, {"project_id": project_id})
    finally:
        reset_dispatch_session(token)
    assert deleted["success"] is True
    await db.refresh(project)
    assert project.deleted_at is not None

    operations = (await db.execute(select(UndoOperation).where(
        UndoOperation.user_id == user_a.id,
        UndoOperation.undo_context_id == "agent-session:910",
        UndoOperation.actor_type == "agent",
    ))).scalars().all()
    assert len(operations) == 1
    preview = await UndoService.preview(db, user_id=user_a.id, context_id="agent-session:910")
    assert preview["available"] is False

    undone = await undo_latest_agent_action(db, user_id=user_a.id, session_id=910)
    assert undone["success"] is True
    await db.refresh(project)
    assert project.deleted_at is None


@pytest.mark.asyncio
async def test_agent_calendar_delete_restores_event_and_reminder(db, user_a, monkeypatch):
    event = await create_event(
        db, user_a.id, title="待恢复活动", date="2099-01-02", time=None,
        end_time=None, event_type="event", project_id=None,
    )
    from app.services.calendar import replace_event_reminders, list_event_reminders
    reminders, error = await replace_event_reminders(db, user_a.id, event, [
        {"lead_minutes": 30, "channels": ["web"]},
    ])
    assert error is None
    reminder_id = reminders[0].id
    await db.commit()
    monkeypatch.setattr(calendar_tools.confirm, "needs_target_confirmation", lambda *a, **k: None)

    token = set_dispatch_session(911, run_id="run-911", tool_call_id="delete-event")
    try:
        deleted = await calendar_tools._delete_event(db, user_a.id, {"event_id": event.id})
    finally:
        reset_dispatch_session(token)
    assert deleted["success"] is True
    await db.refresh(event)
    assert event.deleted_at is not None
    current_reminders = await list_event_reminders(db, user_a.id, event.id)
    assert len(current_reminders) == 1 and current_reminders[0].enabled is False

    undone = await undo_latest_agent_action(db, user_id=user_a.id, session_id=911)
    assert undone["success"] is True
    await db.refresh(event)
    current_reminders = await list_event_reminders(db, user_a.id, event.id)
    assert event.deleted_at is None
    assert len(current_reminders) == 1
    assert current_reminders[0].id == reminder_id and current_reminders[0].enabled is True
