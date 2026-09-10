"""工作区文件夹的写权限与显式 workspace 目标回归。

真实故障链：文件夹侧权限检查把空间算成「project|personal」二值，工作区文件夹
（project_id=None、workspace_directory_id 非空）被当成 personal，而 directory 型
工作区绑定的规范 space 是 "workspace" → 删除/重命名/移动/恢复工作区文件夹全部被
_location_is_in_workspace 误判拒绝。move_items/copy_file 的 target.space enum 也
缺 "workspace"，schema 与 handler 能力脱节（_resolve_target 一直读
workspace_directory_id，但模型传不进来）。
"""
import json

import pytest

from agent.tools.base import reset_dispatch_session, set_dispatch_session
from agent.tools.files import _resolve_create_location
from agent.tools.files.folders import _delete_folder, _rename_folder, _resolve_target
from app.models import ConversationSession, Folder, WorkspaceDirectory
from app.services.workspaces import create_workspace


async def _bind_directory_workspace(db, user_a, name="工作区写权限回归"):
    directory = WorkspaceDirectory(
        user_id=user_a.id, name=name, directory_name=f"workspace-{user_a.id.hex}")
    db.add(directory)
    await db.flush()
    workspace = await create_workspace(
        db, user_a.id, name=name, kind="directory", directory_id=directory.id)
    session = ConversationSession(user_id=user_a.id, title=name, source="web")
    session.workspace_id = workspace.id
    db.add(session)
    await db.flush()
    return directory, session


@pytest.mark.asyncio
async def test_resolve_target_explicit_workspace_uses_bound_directory(db, user_a):
    """move/copy target space=workspace：目录 id 必须取自当前绑定，等价于省略目标。"""
    directory, session = await _bind_directory_workspace(db, user_a)
    token = set_dispatch_session(session.id, session, "test-resolve-target-ws")
    try:
        space, project_id, folder_id, ws_dir_id, err = await _resolve_target(
            db, user_a.id, {"space": "workspace"})
        await db.commit()
    finally:
        reset_dispatch_session(token)
    assert err is None
    assert (space, project_id, folder_id) == ("workspace", None, None)
    assert ws_dir_id == directory.id


@pytest.mark.asyncio
async def test_resolve_target_workspace_without_binding_gives_actionable_error(db, user_a):
    space, project_id, folder_id, ws_dir_id, err = await _resolve_target(
        db, user_a.id, {"space": "workspace"})
    assert err is not None
    assert "space=workspace" in err["error"]


@pytest.mark.asyncio
async def test_delete_and_rename_workspace_folder_in_bound_session(db, user_a):
    """绑定工作区会话里删除/重命名工作区文件夹：不再被「误判成 personal」的权限检查拒绝。"""
    directory, session = await _bind_directory_workspace(db, user_a)
    folder = Folder(user_id=user_a.id, name="待删除", workspace_directory_id=directory.id)
    db.add(folder)
    await db.flush()
    token = set_dispatch_session(session.id, session, "test-folder-ws-rw")
    try:
        renamed = await _rename_folder(db, user_a.id, {
            "folder_id": folder.id, "new_name": "已改名",
        })
        await db.commit()
        assert renamed.get("success") is True, renamed
        deleted = await _delete_folder(db, user_a.id, {"folder_id": folder.id})
        await db.commit()
    finally:
        reset_dispatch_session(token)
    assert deleted.get("success") is True, deleted


def test_move_and_copy_target_schema_accept_workspace_space():
    """schema enum 与 handler 能力一致：target.space=workspace 不再被 schema 挡在业务层之前。"""
    from agent.tools import registry
    from agent.tools.tool_contract import build_validator, validate_input
    move = registry.get("move_items")
    copy = registry.get("copy_file")
    assert validate_input(build_validator(move.input_schema), {"target": {"space": "workspace"}}) == []
    assert validate_input(build_validator(copy.input_schema), {"file_id": 1, "target": {"space": "workspace"}}) == []
