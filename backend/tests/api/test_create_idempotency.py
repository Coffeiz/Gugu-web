"""项目和日历创建的显式幂等键只合并同键、同 payload 的请求。"""
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from starlette.requests import Request

from agent.tools import calendar as calendar_tools
from agent.tools import projects as project_tools
from agent.tools.base import reset_dispatch_session, set_dispatch_session
from app.api.v1 import events as events_api, projects as projects_api
from app.models import CalendarEvent, Project
from app.schemas import EventCreate, ProjectCreate


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": []})


@pytest.mark.asyncio
async def test_web_project_create_replay_returns_same_resource_and_rejects_key_reuse(db, user_a, monkeypatch):
    monkeypatch.setattr(projects_api.events, "publish", _noop)
    body = ProjectCreate(name="幂等项目", start_date="2026-10-20", deadline="2026-10-30")
    first = await projects_api.create_project(_request(), body, "project-request-1", user_a, db)
    replay = await projects_api.create_project(_request(), body, "project-request-1", user_a, db)
    assert replay.id == first.id
    assert len((await db.execute(select(Project).where(Project.user_id == user_a.id))).scalars().all()) == 1

    with pytest.raises(HTTPException) as error:
        await projects_api.create_project(
            _request(), ProjectCreate(name="另一项目", start_date="2026-10-20", deadline="2026-10-30"),
            "project-request-1", user_a, db,
        )
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_web_event_create_replay_returns_same_resource(db, user_a, monkeypatch):
    monkeypatch.setattr(events_api.events, "publish", _noop)
    body = EventCreate(title="幂等活动", date="2026-10-22", time="10:00")
    first = await events_api.create_event(body, user_a, db, _request(), "event-request-1")
    replay = await events_api.create_event(body, user_a, db, _request(), "event-request-1")
    assert replay.id == first.id
    assert len((await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == user_a.id))).scalars().all()) == 1


async def test_agent_project_create_replay_uses_stable_tool_call_key(db, user_a):
    token = set_dispatch_session(42, run_id="run-42", tool_call_id="provider-call-1")
    try:
        args = {
            "project_name": "Agent 幂等项目", "start_date": "2026-10-20", "deadline": "2026-10-30",
            "stages": ["计划", "交付"],
        }
        first = await project_tools._create_project(db, user_a.id, args)
        replay = await project_tools._create_project(db, user_a.id, args)
    finally:
        reset_dispatch_session(token)
    assert first["project_id"] == replay["project_id"]
    assert replay["idempotent_replay"] is True
    assert len((await db.execute(select(Project).where(Project.user_id == user_a.id))).scalars().all()) == 1


async def test_agent_event_create_replay_keeps_one_event(db, user_a):
    token = set_dispatch_session(43, run_id="run-43", tool_call_id="provider-call-2")
    try:
        args = {"title": "Agent 幂等活动", "date": "2026-10-22", "time": "10:00"}
        first = await calendar_tools._create_event(db, user_a.id, args)
        replay = await calendar_tools._create_event(db, user_a.id, args)
    finally:
        reset_dispatch_session(token)
    assert first["event_id"] == replay["event_id"]
    assert replay["idempotent_replay"] is True
    assert len((await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == user_a.id))).scalars().all()) == 1


async def _noop(*_args, **_kwargs):
    return None
