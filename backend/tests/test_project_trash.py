"""项目回收站：列表保留期、恢复和自动清理回归。"""

from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.api.v1 import projects as projects_api
from app.api.v1 import trash as trash_api
from app.core.tz import now_utc
from app.models import CalendarEvent, File, Folder, Project, ScheduledTask
from app.services.projects import list_project_rows


async def _save(db, row):
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_deleted_project_list_only_contains_projects_within_retention(db, user_a):
    recent = await _save(db, Project(
        user_id=user_a.id, name="近期项目", deleted_at=now_utc() - timedelta(days=29),
    ))
    expired = await _save(db, Project(
        user_id=user_a.id, name="过期项目", deleted_at=now_utc() - timedelta(days=31),
    ))
    live = await _save(db, Project(user_id=user_a.id, name="正常项目"))

    rows = await list_project_rows(db, user_a.id, archived=False, deleted=True)

    assert [project.id for project, _ in rows] == [recent.id]
    assert expired.id != recent.id and live.id != recent.id


@pytest.mark.asyncio
async def test_restore_deleted_project_restores_event_and_reminder(db, user_a, monkeypatch):
    stamp = now_utc() - timedelta(days=2)
    project = await _save(db, Project(
        user_id=user_a.id, name="可恢复项目", deleted_at=stamp, version=2,
    ))
    event = await _save(db, CalendarEvent(
        user_id=user_a.id, project_id=project.id, title="项目节点", date="2026-09-20",
        deleted_at=stamp, version=2,
    ))
    task = await _save(db, ScheduledTask(
        user_id=user_a.id, event_id=event.id, name="节点提醒", payload="提醒",
        cron="@once:2026-09-20T08:00:00+00:00", schedule_kind="once", enabled=False,
    ))
    published = []

    async def publish(*args, **kwargs):
        published.append((args, kwargs))

    monkeypatch.setattr(projects_api.events, "publish", publish)
    request = SimpleNamespace(headers={"X-Client-Id": "project-trash-test"})

    response = await projects_api.restore_project(project.id, request, user_a, db)

    await db.refresh(project)
    await db.refresh(event)
    await db.refresh(task)
    assert response.deleted_at is None
    assert project.deleted_at is None and event.deleted_at is None
    assert task.event_id == event.id and task.enabled is True
    assert {kwargs["operation"] for _, kwargs in published} == {"create", "update"}


@pytest.mark.asyncio
async def test_cleanup_expired_projects_removes_project_rows(db, user_a, monkeypatch):
    project = await _save(db, Project(
        user_id=user_a.id, name="过期项目", deleted_at=now_utc() - timedelta(days=31),
    ))
    event = await _save(db, CalendarEvent(
        user_id=user_a.id, project_id=project.id, title="过期节点", date="2026-09-20",
        deleted_at=project.deleted_at,
    ))
    task = await _save(db, ScheduledTask(
        user_id=user_a.id, event_id=event.id, name="过期提醒", payload="提醒",
        cron="@once:2026-09-20T08:00:00+00:00", schedule_kind="once", enabled=False,
    ))

    class FakeStorage:
        async def delete(self, _key):
            return None

        async def remove_folder(self, _key):
            return None

    monkeypatch.setattr(trash_api, "get_storage", lambda: FakeStorage())

    await trash_api.cleanup_expired(db)

    assert await db.get(Project, project.id) is None
    assert await db.get(CalendarEvent, event.id) is None
    assert await db.get(ScheduledTask, task.id) is None

@pytest.mark.asyncio
async def test_agent_delete_project_soft_deletes_like_web(db, user_a, monkeypatch):
    """咕咕删除项目工具与网页同口径：项目行保留（软删），文件进回收站，
    文件夹/活动软删、联动任务停用，并广播 delete 实时事件。"""
    import agent.tools.projects as agent_projects

    project = await _save(db, Project(user_id=user_a.id, name="咕咕要删的项目"))
    folder = await _save(db, Folder(user_id=user_a.id, project_id=project.id, name="成果目录"))
    file = await _save(db, File(
        user_id=user_a.id, project_id=project.id, display_name="成果图", ext="png",
        storage_key=f"{user_a.id}/project/a.png",
    ))
    event = await _save(db, CalendarEvent(
        user_id=user_a.id, project_id=project.id, title="节点", date="2026-09-20",
    ))
    task = await _save(db, ScheduledTask(
        user_id=user_a.id, event_id=event.id, name="节点提醒", payload="提醒",
        cron="@once:2026-09-20T08:00:00+00:00", schedule_kind="once", enabled=True,
    ))

    class FakeStorage:
        async def move_to_trash(self, key, trash_key):
            return trash_key

    monkeypatch.setattr(agent_projects, "get_storage", lambda: FakeStorage())
    monkeypatch.setattr(agent_projects.confirm, "needs_confirmation", lambda *a, **k: None)
    published = []

    async def publish(*args, **kwargs):
        published.append(kwargs.get("entity_id"))

    monkeypatch.setattr(agent_projects.events, "publish", publish)

    from agent.tools.projects import _delete_project
    res = await _delete_project(db, user_a.id, {"project_id": project.id})
    assert res.get("success") is True

    row = await db.get(Project, project.id)
    assert row is not None and row.deleted_at is not None           # 项目行保留（软删）
    assert (await db.get(File, file.id)).deleted_at is not None     # 文件进回收站
    assert (await db.get(Folder, folder.id)).deleted_at is not None
    assert (await db.get(CalendarEvent, event.id)).deleted_at is not None
    assert (await db.get(ScheduledTask, task.id)).enabled is False
    assert published == [project.id]
