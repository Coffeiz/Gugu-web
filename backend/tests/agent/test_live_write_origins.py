"""回归：浏览器写入产生的实时事件必须带上当前标签页来源。"""

from datetime import datetime, timezone

import pytest
from starlette.requests import Request

from app.api.v1.events import create_event
from app.api.v1.scheduled_tasks import TaskCreate, create_task
from app.schemas import EventCreate


def _request(client_id: str) -> Request:
    return Request({
        "type": "http",
        "method": "POST",
        "headers": [(b"x-client-id", client_id.encode())],
    })


@pytest.mark.asyncio
async def test_calendar_create_event_preserves_browser_origin(db, user_a, monkeypatch):
    published = []

    async def publish(user_id, *resources, origin=None, **kwargs):
        published.append((user_id, resources, origin, kwargs))

    monkeypatch.setattr("app.api.v1.events.events.publish", publish)

    response = await create_event(
        EventCreate(title="测试活动", date="2099-01-01"),
        current_user=user_a,
        db=db,
        request=_request("calendar-tab"),
    )

    assert response.id is not None
    assert published[0][1:3] == (("calendar",), "calendar-tab")
    assert published[0][3]["operation"] == "create"


@pytest.mark.asyncio
async def test_scheduled_task_create_preserves_browser_origin(db, user_a, monkeypatch):
    published = []

    async def publish(user_id, *resources, origin=None, **kwargs):
        published.append((user_id, resources, origin, kwargs))

    monkeypatch.setattr("app.api.v1.scheduled_tasks.events.publish", publish)

    response = await create_task(
        TaskCreate(
            name="测试任务",
            schedule_kind="once",
            start_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
        ),
        user=user_a,
        db=db,
        request=_request("schedule-tab"),
    )

    assert response["id"] is not None
    assert published[0][1:3] == (("scheduled_tasks",), "schedule-tab")
    assert published[0][3]["operation"] == "create"
