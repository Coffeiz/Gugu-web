"""统一撤销层 Phase 2：项目与日历领域回归。"""

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.tz import now_utc
from app.models import CalendarEvent, Project, ScheduledTask, UndoOperation
from app.api.v1.projects import delete_project
from app.services.undo import UndoService
from app.services.undo.domains import domain_ref, domain_state, event_snapshot, project_snapshot, task_snapshot
from app.services.undo.service import UndoError


async def _save(db, row):
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_project_update_undo_and_redo_restores_fields(db, user_a):
    project = await _save(db, Project(user_id=user_a.id, name="项目甲", status="pending", archived=False))
    ref = domain_ref("project", project.id)
    before = project_snapshot(project)
    project.status = "done"
    project.archived = True
    project.version = 2
    await db.commit()
    await db.refresh(project)
    after = project_snapshot(project)
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase2-project", resource="projects", action="update",
        target_refs=[{"kind": "project", "id": project.id}],
        before_state=domain_state({ref: before}), after_state=domain_state({ref: after}),
        base_versions={ref: {"version": before["version"]}},
    )
    await db.commit()

    await UndoService.apply(db, user_id=user_a.id, context_id="phase2-project", operation_id=operation.id, mode="undo")
    await db.commit()
    await db.refresh(project)
    assert (project.status, project.archived, project.version) == ("pending", False, 3)

    await UndoService.apply(db, user_id=user_a.id, context_id="phase2-project", operation_id=operation.id, mode="redo")
    await db.commit()
    await db.refresh(project)
    assert (project.status, project.archived, project.version) == ("done", True, 4)


@pytest.mark.asyncio
async def test_calendar_delete_undo_and_redo_preserves_reminder_relation(db, user_a):
    event = await _save(db, CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-20", version=1))
    task = await _save(db, ScheduledTask(
        user_id=user_a.id, event_id=event.id, name="发布会提醒", payload="提醒",
        cron="@once:2026-09-20T08:00:00+00:00", schedule_kind="once", enabled=True,
    ))
    event_ref, task_ref = domain_ref("event", event.id), domain_ref("task", task.id)
    before = {event_ref: event_snapshot(event), task_ref: task_snapshot(task)}
    event.deleted_at = now_utc()
    event.version = 2
    task.enabled = False
    await db.commit()
    await db.refresh(event)
    await db.refresh(task)
    after = {event_ref: event_snapshot(event), task_ref: task_snapshot(task)}
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase2-calendar", resource="calendar", action="delete",
        target_refs=[{"kind": "event", "id": event.id}, {"kind": "task", "id": task.id}],
        before_state=domain_state(before), after_state=domain_state(after),
        base_versions={ref: {"version": state.get("version", 0)} for ref, state in before.items()},
    )
    await db.commit()

    await UndoService.apply(db, user_id=user_a.id, context_id="phase2-calendar", operation_id=operation.id, mode="undo")
    await db.commit()
    await db.refresh(event)
    await db.refresh(task)
    assert event.deleted_at is None
    assert task.event_id == event.id and task.enabled is True

    await UndoService.apply(db, user_id=user_a.id, context_id="phase2-calendar", operation_id=operation.id, mode="redo")
    await db.commit()
    await db.refresh(event)
    await db.refresh(task)
    assert event.deleted_at is not None
    assert task.event_id == event.id and task.enabled is False


@pytest.mark.asyncio
async def test_calendar_create_groups_follow_up_reminder_with_event(db, user_a):
    event = await _save(db, CalendarEvent(user_id=user_a.id, title="新活动", date="2026-09-22"))
    event_ref = domain_ref("event", event.id)
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase2-calendar-create", resource="calendar", action="create",
        target_refs=[{"kind": "event", "id": event.id}], before_state=domain_state({}),
        after_state=domain_state({event_ref: event_snapshot(event)}),
        base_versions={event_ref: {"version": 0}},
    )
    task = ScheduledTask(
        user_id=user_a.id, event_id=event.id, name="新活动提醒", payload="提醒",
        cron="@once:2026-09-22T08:00:00+00:00", schedule_kind="once", enabled=True,
    )
    db.add(task)
    await db.flush()
    await UndoService.attach_calendar_create_task(
        db, user_id=user_a.id, context_id="phase2-calendar-create", event_id=event.id, task=task,
    )
    await db.commit()

    await UndoService.apply(
        db, user_id=user_a.id, context_id="phase2-calendar-create", operation_id=operation.id, mode="undo",
    )
    await db.commit()
    await db.refresh(event)
    await db.refresh(task)
    assert event.deleted_at is not None and task.enabled is False

    await UndoService.apply(
        db, user_id=user_a.id, context_id="phase2-calendar-create", operation_id=operation.id, mode="redo",
    )
    await db.commit()
    await db.refresh(event)
    await db.refresh(task)
    assert event.deleted_at is None and task.enabled is True


@pytest.mark.asyncio
async def test_domain_undo_rejects_project_change_after_operation(db, user_a):
    project = await _save(db, Project(user_id=user_a.id, name="项目乙", status="pending"))
    ref = domain_ref("project", project.id)
    before = project_snapshot(project)
    project.status = "active"
    project.version = 2
    await db.commit()
    await db.refresh(project)
    operation = await UndoService.record_forward(
        db, user_id=user_a.id, context_id="phase2-conflict", resource="projects", action="update",
        target_refs=[{"kind": "project", "id": project.id}], before_state=domain_state({ref: before}),
        after_state=domain_state({ref: project_snapshot(project)}), base_versions={ref: {"version": 1}},
    )
    await db.commit()
    project.version = 3
    await db.commit()

    with pytest.raises(UndoError) as error:
        await UndoService.apply(db, user_id=user_a.id, context_id="phase2-conflict", operation_id=operation.id, mode="undo")
    assert getattr(error.value, "code", None) == "undo.conflict"


@pytest.mark.asyncio
async def test_project_delete_is_soft_and_restores_project_and_reminder(db, user_a):
    project = await _save(db, Project(user_id=user_a.id, name="可恢复项目", status="active"))
    event = await _save(db, CalendarEvent(
        user_id=user_a.id, project_id=project.id, title="项目提醒", date="2026-09-21",
    ))
    task = await _save(db, ScheduledTask(
        user_id=user_a.id, event_id=event.id, name="项目提醒", payload="提醒",
        cron="@once:2026-09-21T08:00:00+00:00", schedule_kind="once", enabled=True,
    ))
    request = SimpleNamespace(headers={"X-Undo-Context-ID": "phase2-project-delete", "X-Client-Id": "test"})

    await delete_project(project.id, request, user_a, db)
    await db.refresh(project)
    await db.refresh(event)
    await db.refresh(task)
    assert project.deleted_at is not None
    assert event.deleted_at is not None
    assert task.enabled is False
    operation = (await db.execute(select(UndoOperation).where(
        UndoOperation.undo_context_id == "phase2-project-delete",
    ))).scalar_one()

    result = await UndoService.apply(
        db, user_id=user_a.id, context_id="phase2-project-delete",
        operation_id=operation.id, mode="undo",
    )
    await db.commit()
    await db.refresh(project)
    await db.refresh(event)
    await db.refresh(task)
    assert project.deleted_at is None
    assert event.deleted_at is None
    assert task.event_id == event.id and task.enabled is True
    assert {event["resource"] for event in result["events"]} == {
        "projects", "calendar", "scheduled_tasks",
    }
