"""项目网页写入应通知同一用户的其他标签页。"""
from pathlib import Path

import pytest
from starlette.requests import Request
from sqlalchemy import select

from app.api.v1 import projects
from app.core.project_colors import PROJECT_COLOR_PRESETS
from app.models import File, FileSyncBinding, FileSyncJournal, Project, UndoOperation
from app.schemas import ProjectUpdate
from app.services.storage import LocalStorageBackend
from app.services.undo import UndoService


def _request(client_id: str, context_id: str | None = None) -> Request:
    headers = [(b"x-client-id", client_id.encode())]
    if context_id:
        headers.append((b"x-undo-context-id", context_id.encode()))
    return Request({
        "type": "http",
        "method": "PATCH",
        "path": "/api/v1/projects/1",
        "headers": headers,
    })


@pytest.mark.asyncio
async def test_project_update_publishes_projects_event_for_other_tabs(db, user_a, monkeypatch):
    project = Project(user_id=user_a.id, name="项目", stages_json="[]", version=1)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    published = []

    async def publish(user_id, *resources, origin=None, **kwargs):
        published.append((user_id, resources, origin, kwargs))

    monkeypatch.setattr(projects.events, "publish", publish)

    await projects.update_project(
        project.id,
        _request("tab-a"),
        ProjectUpdate(color=PROJECT_COLOR_PRESETS[0], version=1),
        user_a,
        db,
    )

    assert len(published) == 1
    user_id, resources, origin, kwargs = published[0]
    assert (user_id, resources, origin) == (user_a.id, ("projects",), "tab-a")
    assert kwargs["operation"] == "update"
    assert kwargs["entity_id"] == project.id
    assert kwargs["event_payload"]["id"] == project.id


@pytest.mark.asyncio
async def test_project_update_refreshes_after_atomic_update_before_undo_snapshot(db, user_a, monkeypatch):
    project = Project(
        user_id=user_a.id,
        name="项目",
        stages_json="[]",
        version=1,
        done_at=None,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    async def publish(*_args, **_kwargs):
        return None

    monkeypatch.setattr(projects.events, "publish", publish)

    response = await projects.update_project(
        project.id,
        _request("tab-a"),
        ProjectUpdate(color=PROJECT_COLOR_PRESETS[1], version=1),
        user_a,
        db,
    )

    assert response.version == 2
    assert response.color == PROJECT_COLOR_PRESETS[1]


@pytest.mark.asyncio
async def test_project_rename_and_undo_advance_file_sync_paths(db, user_a, monkeypatch, tmp_path):
    """项目目录改名及撤回必须分别让旧/新文件路径进入绑定增量对账。"""
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    import app.services.undo.domains as undo_domains

    settings = type("Settings", (), {
        "filesync": type("FileSyncSettings", (), {"enabled": True})(),
        "storage": type("StorageSettings", (), {
            "backend": "local", "local_path": str(tmp_path),
        })(),
    })()
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)

    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr(projects, "get_storage", lambda: storage)
    monkeypatch.setattr(undo_domains, "get_storage", lambda: storage)

    async def publish(*_args, **_kwargs):
        return None

    monkeypatch.setattr(projects.events, "publish", publish)

    project = Project(
        user_id=user_a.id, name="before", start_date="2026-09-15",
        stages_json="[]", version=1,
    )
    db.add(project)
    await db.flush()
    old_key = f"{user_a.id}/项目文件/2026/09/before #{project.id}/notes.md"
    await storage.put(old_key, b"project data", "text/markdown")
    file_row = File(
        user_id=user_a.id, project_id=project.id, display_name="notes", ext="MD",
        space="project", storage_key=old_key, size_bytes=12,
    )
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path=".", root_fingerprint="a" * 64,
    )
    db.add_all([file_row, binding])
    await db.flush()

    context_id = "project-rename-filesync"
    await projects.update_project(
        project.id, _request("tab-a", context_id),
        ProjectUpdate(name="after", version=1), user_a, db,
    )
    renamed_key = f"{user_a.id}/项目文件/2026/09/after #{project.id}/notes.md"
    assert await storage.exists(renamed_key)
    await db.refresh(file_row)
    assert file_row.storage_key == renamed_key

    operation = await db.scalar(select(UndoOperation).where(
        UndoOperation.undo_context_id == context_id,
    ))
    assert operation is not None
    await UndoService.apply(
        db, user_id=user_a.id, context_id=context_id,
        operation_id=operation.id, mode="undo",
    )
    await db.flush()
    await db.refresh(file_row)
    assert file_row.storage_key == old_key
    assert await storage.exists(old_key)

    changes = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ).order_by(FileSyncJournal.id))).all()
    assert [(row.relative_path, row.operation) for row in changes] == [
        (f"项目文件/2026/09/before #{project.id}/notes.md", "delete"),
        (f"项目文件/2026/09/after #{project.id}/notes.md", "create"),
        (f"项目文件/2026/09/after #{project.id}/notes.md", "delete"),
        (f"项目文件/2026/09/before #{project.id}/notes.md", "create"),
    ]
    await db.refresh(binding)
    assert binding.dirty_revision == 4
