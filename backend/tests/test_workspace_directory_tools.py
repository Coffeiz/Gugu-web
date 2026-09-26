"""Agent 工作区目录工具的行为与安全边界。"""

import json

import pytest
from sqlalchemy import select

from agent.tools.workspaces import WorkspacesSkill
from app.models import Workspace, WorkspaceDirectory
from app.services.workspaces import create_workspace_directory


def _tools_by_name():
    return {tool.name: tool for tool in WorkspacesSkill.tools}


def _local_storage(monkeypatch, tmp_path):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))
    monkeypatch.setattr("app.services.workspaces.ensure_sandbox_acl", lambda _root: True)


def test_workspace_tools_unify_directory_listing_and_creation_but_keep_explicit_delete():
    tools = _tools_by_name()

    assert "list_workspace_directories" not in tools
    assert "create_workspace_directory" not in tools
    assert "delete_workspace_directory" in tools
    assert tools["delete_workspace_directory"].destructive is True
    assert "directory_id" in tools["delete_workspace_directory"].input_schema["properties"]
    assert tools["create_workspace"].input_schema["properties"]["kind"]["enum"] == [
        "project", "folder", "directory",
    ]


def test_workspace_binding_removal_is_exposed_as_unlink_not_delete():
    tools = _tools_by_name()

    assert "unlink_workspace" in tools
    assert "delete_workspace" not in tools
    assert tools["unlink_workspace"].destructive is True
    assert "workspace_id" in tools["unlink_workspace"].input_schema["properties"]
    assert "delete_workspace_directory" in tools["unlink_workspace"].description


@pytest.mark.asyncio
async def test_agent_creates_and_lists_directories_as_workspace_targets(db, user_a, user_b, tmp_path, monkeypatch):
    _local_storage(monkeypatch, tmp_path)
    tools = _tools_by_name()

    created = await tools["create_workspace"].handler(db, user_a.id, {
        "name": "资料区", "kind": "directory",
    })
    assert created["success"] is True
    item = created["workspace"]
    assert item["workspace_id"] > 0
    assert item["kind"] == "directory"
    assert item["directory_id"] > 0
    assert item["directory_name"] == "资料区"
    root = tmp_path / str(user_a.id) / f"workspace-{item['directory_id']}"
    assert root.is_dir()
    await db.commit()

    await create_workspace_directory(db, user_b.id, name="他人的目录")
    await db.commit()
    listed_a = await tools["list_workspaces"].handler(db, user_a.id, {})
    listed_b = await tools["list_workspaces"].handler(db, user_b.id, {})

    assert {row["name"] for row in listed_a} == {"默认工作区", "资料区"}
    assert all("workspace_id" in row and "kind" in row for row in listed_a)
    assert all(row["directory_id"] is not None for row in listed_a if row["kind"] == "directory")
    assert sum(row["directory_id"] == item["directory_id"] for row in listed_a) == 1
    assert {row["name"] for row in listed_b} == {"默认工作区", "他人的目录"}
    assert all(row["directory_id"] != item["directory_id"] for row in listed_b)


@pytest.mark.asyncio
async def test_agent_renames_directory_workspace_and_physical_display_name_together(
    db, user_a, tmp_path, monkeypatch,
):
    _local_storage(monkeypatch, tmp_path)
    tools = _tools_by_name()
    created = await tools["create_workspace"].handler(db, user_a.id, {
        "name": "旧名称", "kind": "directory",
    })

    result = await tools["update_workspace"].handler(db, user_a.id, {
        "workspace_id": created["workspace"]["workspace_id"],
        "name": "新名称",
    })

    assert result["workspace"]["name"] == "新名称"
    assert result["workspace"]["directory_name"] == "新名称"


@pytest.mark.asyncio
async def test_agent_delete_workspace_directory_requires_confirmation_then_removes_root(
    db, user_a, tmp_path, monkeypatch,
):
    from agent.interactions import confirmations

    _local_storage(monkeypatch, tmp_path)
    row = await create_workspace_directory(db, user_a.id, name="待删除目录")
    await db.commit()
    root = tmp_path / str(user_a.id) / row.directory_name
    (root / "保留检查.txt").write_text("test", encoding="utf-8")

    class NoLiveTerminals:
        def get(self, _terminal_id):
            return None

    monkeypatch.setattr("agent.terminal.runtime.get_pty_manager", lambda: NoLiveTerminals())
    delete_tool = _tools_by_name().get("delete_workspace_directory")
    assert delete_tool is not None

    blocked = await delete_tool.handler(db, user_a.id, {"directory_id": row.id})
    payload = json.loads(blocked)
    assert payload["needs_confirm"] is True
    assert "待删除目录" in payload["summary"]
    assert root.is_dir()
    assert await db.get(WorkspaceDirectory, row.id) is not None

    assert confirmations.redeem_confirmation(user_a.id, payload["confirm_code"]) is not None
    result = await delete_tool.handler(db, user_a.id, {"directory_id": row.id})

    assert result == {"success": True, "deleted_directory_id": row.id, "name": "待删除目录"}
    assert not root.exists()
    deleted = await db.get(WorkspaceDirectory, row.id)
    await db.refresh(deleted)
    assert deleted.deleted_at is not None
    assert await db.scalar(select(Workspace).where(
        Workspace.user_id == user_a.id, Workspace.directory_id == row.id,
    )) is None


@pytest.mark.asyncio
async def test_agent_cannot_delete_another_users_workspace_directory(db, user_a, user_b, tmp_path, monkeypatch):
    _local_storage(monkeypatch, tmp_path)
    row = await create_workspace_directory(db, user_b.id, name="小北的目录")
    await db.commit()
    root = tmp_path / str(user_b.id) / row.directory_name
    delete_tool = _tools_by_name().get("delete_workspace_directory")
    assert delete_tool is not None

    result = await delete_tool.handler(db, user_a.id, {"directory_id": row.id})

    assert result == {"error": "Workspace 目录不存在"}
    assert root.is_dir()
    assert (await db.get(WorkspaceDirectory, row.id)).deleted_at is None


@pytest.mark.asyncio
async def test_agent_cannot_delete_default_workspace_directory(db, user_a, tmp_path, monkeypatch):
    from app.services.workspaces import ensure_default_workspace_directory

    _local_storage(monkeypatch, tmp_path)
    row = await ensure_default_workspace_directory(db, user_a.id)
    await db.commit()

    result = await _tools_by_name()["delete_workspace_directory"].handler(
        db, user_a.id, {"directory_id": row.id},
    )

    assert result == {"error": "默认工作区不可删除"}
    assert (tmp_path / str(user_a.id) / row.directory_name).is_dir()
