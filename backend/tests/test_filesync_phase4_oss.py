from types import SimpleNamespace

import pytest

from sqlalchemy import select

from app.models import File, FileSyncBinding, Workspace
from app.services.filesync import create_binding, dry_run_local_binding, list_user_bindings
from app.services.filesystem_authorization import filesystem_authorization_enabled
from app.services.scheduled_tasks import validate_task_workspace
from app.services.workspaces import (
    delete_workspace,
    resolve_project_root,
    resolve_user_personal_root,
    update_workspace,
)


def _oss_settings(tmp_path, *, authorization=True):
    return SimpleNamespace(
        storage=SimpleNamespace(backend="oss", local_path=str(tmp_path)),
        sandbox=SimpleNamespace(filesystem_authorization_enabled=authorization),
        filesync=SimpleNamespace(enabled=True),
    )


@pytest.mark.asyncio
async def test_oss_workspace_mutations_and_task_binding_are_rejected(db, user_a, monkeypatch, tmp_path):
    import app.services.workspaces as workspaces

    monkeypatch.setattr(workspaces, "get_settings", lambda: _oss_settings(tmp_path))
    row = Workspace(user_id=user_a.id, name="legacy", kind="project", project_id=None)
    db.add(row)
    await db.flush()

    with pytest.raises(ValueError, match="OSS"):
        await update_workspace(db, user_a.id, row.id, name="blocked")
    with pytest.raises(ValueError, match="OSS"):
        await delete_workspace(db, user_a.id, row.id)
    with pytest.raises(LookupError, match="OSS"):
        await validate_task_workspace(db, user_a.id, row.id)


@pytest.mark.asyncio
async def test_oss_hides_local_sync_state_and_never_creates_file_rows(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.protocol as protocol
    import app.services.filesync.bindings as bindings

    monkeypatch.setattr(bindings, "get_settings", lambda: _oss_settings(tmp_path))
    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: False)
    monkeypatch.setattr(protocol, "get_settings", lambda: _oss_settings(tmp_path))
    assert await list_user_bindings(db, user_a.id) == []
    result = await dry_run_local_binding(db, user_a.id, root_path=".")
    assert result.summary.rejected == 1
    assert (await db.scalars(select(FileSyncBinding))).all() == []
    assert (await db.scalars(select(File))).all() == []

    with pytest.raises(ValueError, match="OSS"):
        await create_binding(db, user_id=user_a.id, source="local_directory", root_fingerprint="a" * 64)


@pytest.mark.asyncio
async def test_oss_does_not_expose_personal_or_project_roots(db, user_a, monkeypatch, tmp_path):
    import app.services.workspaces as workspaces

    monkeypatch.setattr(workspaces, "get_settings", lambda: _oss_settings(tmp_path))
    assert await resolve_user_personal_root(db, user_a.id) is None
    assert await resolve_project_root(db, user_a.id) is None


def test_oss_disables_full_user_sandbox_authorization(monkeypatch, tmp_path):
    import app.services.filesystem_authorization as authorization

    monkeypatch.setattr(authorization, "get_settings", lambda: _oss_settings(tmp_path))
    assert filesystem_authorization_enabled() is False


@pytest.mark.asyncio
async def test_oss_removes_workspace_tool_before_model_schema_is_built(db, user_a, monkeypatch, tmp_path):
    import app.services.workspaces as workspaces
    from agent.runner import _filter_shell_tool

    monkeypatch.setattr(workspaces, "get_settings", lambda: _oss_settings(tmp_path))
    names = await _filter_shell_tool(db, user_a.id, None, ["workspaces", "files"])
    assert names == ["files"]


@pytest.mark.asyncio
async def test_oss_workspace_command_is_rejected_before_help_or_database_access(user_a, monkeypatch, tmp_path):
    import app.services.workspaces as workspaces
    from agent.commands.workspace import handle

    monkeypatch.setattr(workspaces, "get_settings", lambda: _oss_settings(tmp_path))
    result = await handle(user_a.id, None, "help", "zh-CN")
    assert "OSS" in result
    assert "独立沙盒" in result
