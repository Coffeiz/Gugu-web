"""项目网页写入应通知同一用户的其他标签页。"""
import pytest
from starlette.requests import Request

from app.api.v1 import projects
from app.models import Project
from app.schemas import ProjectUpdate


def _request(client_id: str) -> Request:
    return Request({
        "type": "http",
        "method": "PATCH",
        "path": "/api/v1/projects/1",
        "headers": [(b"x-client-id", client_id.encode())],
    })


@pytest.mark.asyncio
async def test_project_update_publishes_projects_event_for_other_tabs(db, user_a, monkeypatch):
    project = Project(user_id=user_a.id, name="项目", stages_json="[]", version=1)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    published = []

    async def publish(user_id, *resources, origin=None):
        published.append((user_id, resources, origin))

    monkeypatch.setattr(projects.events, "publish", publish)

    await projects.update_project(
        project.id,
        _request("tab-a"),
        ProjectUpdate(color="#778899", version=1),
        user_a,
        db,
    )

    assert published == [(user_a.id, ("projects",), "tab-a")]
