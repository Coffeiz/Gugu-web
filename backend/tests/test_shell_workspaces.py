"""Shell Phase 0-2：工作区归属、会话绑定和默认权限行为。"""

import pytest
from types import SimpleNamespace

from app.core.config import AgentBehaviorSettings
from app.models import ConversationSession, Folder, Project
from app.services.workspaces import (
    bind_session,
    create_workspace,
    delete_workspace,
    describe_session,
    list_workspaces,
    update_workspace,
)
import app.services.workspaces as workspace_service


@pytest.mark.asyncio
async def test_sandbox_shell_is_enabled_by_default_but_system_shell_is_disabled():
    settings = AgentBehaviorSettings()
    assert settings.shell_enabled is True
    assert settings.shell_system_enabled is False


@pytest.mark.asyncio
async def test_workspace_binding_is_owned_and_can_be_cleared(db, user_a, user_b):
    project = Project(user_id=user_a.id, name="测试项目")
    db.add(project)
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name="项目工作区", kind="project", project_id=project.id,
    )
    session = ConversationSession(user_id=user_a.id, title="测试会话", source="web")
    db.add(session)
    await db.flush()

    with pytest.raises(LookupError):
        await bind_session(db, user_b.id, session.id, workspace.id)

    await bind_session(db, user_a.id, session.id, workspace.id)
    await db.commit()
    assert (await describe_session(db, user_a.id, session.id)).id == workspace.id

    await bind_session(db, user_a.id, session.id, None)
    await db.commit()
    assert await describe_session(db, user_a.id, session.id) is None
    assert [item.id for item in await list_workspaces(db, user_a.id)] == [workspace.id]


@pytest.mark.asyncio
async def test_oss_storage_keeps_a_local_sandbox_root(tmp_path, monkeypatch):
    monkeypatch.setattr(
        workspace_service,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(backend="oss", local_path=str(tmp_path))),
    )
    root = await workspace_service.resolve_sandbox_root(None, "user-oss")
    assert root == (tmp_path / "user-oss" / "shell").resolve()
    assert root.is_dir()


@pytest.mark.asyncio
async def test_project_root_is_the_user_project_library_not_bound_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(
        workspace_service,
        "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(backend="local", local_path=str(tmp_path))),
    )
    root = await workspace_service.resolve_project_root(None, "user-project")
    assert root == (tmp_path / "user-project" / "项目文件").resolve()
    assert root.is_dir()


@pytest.mark.asyncio
async def test_workspace_can_be_renamed_disabled_and_deleted_without_deleting_project(db, user_a):
    project = Project(user_id=user_a.id, name="保留项目")
    db.add(project)
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name="旧工作区", kind="project", project_id=project.id,
    )
    session = ConversationSession(user_id=user_a.id, title="绑定会话", source="web")
    session.workspace_id = workspace.id
    db.add(session)
    await db.flush()

    await update_workspace(db, user_a.id, workspace.id, name="新工作区", enabled=False)
    assert workspace.name == "新工作区"
    assert workspace.enabled is False
    with pytest.raises(ValueError, match="不能为空"):
        await update_workspace(db, user_a.id, workspace.id, name="   ")

    await delete_workspace(db, user_a.id, workspace.id)
    await db.commit()
    assert await describe_session(db, user_a.id, session.id) is None
    assert (await db.get(Project, project.id)).name == "保留项目"


@pytest.mark.asyncio
async def test_bound_workspace_resolves_file_target_and_rejects_other_project(db, user_a):
    """绑定个人文件夹时，文件工具默认落到该文件夹，不能被同值项目 id 带偏。"""
    personal = Folder(user_id=user_a.id, name="工作区文件夹", project_id=None)
    project = Project(user_id=user_a.id, name="另一个项目")
    db.add_all([personal, project])
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name="个人工作区", kind="folder", folder_id=personal.id,
    )
    session = ConversationSession(user_id=user_a.id, title="绑定文件夹", source="web")
    session.workspace_id = workspace.id
    db.add(session)
    await db.flush()

    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    from agent.tools.files import _resolve_create_location

    token = set_dispatch_session(session.id, session, "test-workspace-target")
    try:
        assert await _resolve_create_location(db, user_a.id, {}) == (
            "personal", None, personal.id, None,
        )
        conflict = await _resolve_create_location(
            db, user_a.id, {"space": "project", "project_id": project.id},
        )
        assert "不能写入其它项目或文件夹" in conflict[3]
    finally:
        reset_dispatch_session(token)
