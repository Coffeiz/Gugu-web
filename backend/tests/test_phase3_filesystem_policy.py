"""PRD-SHELL-4 Phase 3：文件工具策略复用与显式脚本边界。"""

import pytest
from pathlib import PurePosixPath

from app.models import ConversationSession, File, Folder, Workspace
from app.services.filesystem_authorization import (
    FilesystemPolicy,
    filesystem_location_can_write,
)


async def _persist(db, row):
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_workspace_policy_allows_only_workspace_folder_subtree(db, user_a):
    root = await _persist(db, Folder(user_id=user_a.id, name="脚本根"))
    child = await _persist(db, Folder(user_id=user_a.id, parent_id=root.id, name="jobs"))
    other = await _persist(db, Folder(user_id=user_a.id, name="其它"))
    workspace = await _persist(db, Workspace(
        user_id=user_a.id, name="脚本工作区", kind="folder", folder_id=root.id,
        enabled=True,
    ))
    policy = FilesystemPolicy(workspace_id=workspace.id)

    assert await filesystem_location_can_write(
        db, user_a.id, policy, space="personal", folder_id=root.id,
    )
    assert await filesystem_location_can_write(
        db, user_a.id, policy, space="personal", folder_id=child.id,
    )
    assert not await filesystem_location_can_write(
        db, user_a.id, policy, space="personal", folder_id=other.id,
    )
    assert not await filesystem_location_can_write(
        db, user_a.id, policy, space="personal", folder_id=None,
    )


@pytest.mark.asyncio
async def test_agent_file_target_accepts_workspace_descendant_folder(db, user_a):
    """move/copy 目标应遵循统一策略，不能把 workspace 根误当成唯一目录。"""
    from agent.tools.files import _location_matches

    root = await _persist(db, Folder(user_id=user_a.id, name="移动根"))
    child = await _persist(db, Folder(user_id=user_a.id, parent_id=root.id, name="图表"))
    other = await _persist(db, Folder(user_id=user_a.id, name="其它位置"))
    workspace = await _persist(db, Workspace(
        user_id=user_a.id, name="移动工作区", kind="folder", folder_id=root.id,
        enabled=True,
    ))
    target = {"workspace_id": workspace.id}

    assert await _location_matches(
        db, user_a.id, "personal", None, child.id, target,
    )
    assert not await _location_matches(
        db, user_a.id, "personal", None, other.id, target,
    )


@pytest.mark.asyncio
async def test_full_grant_allows_personal_and_project_file_writes(db, user_a):
    policy = FilesystemPolicy(personal_read_only=False, project_read_only=False)

    assert await filesystem_location_can_write(
        db, user_a.id, policy, space="personal", folder_id=None,
    )
    assert await filesystem_location_can_write(
        db, user_a.id, policy, space="project", project_id=999, folder_id=None,
    )


@pytest.mark.asyncio
async def test_agent_file_create_defaults_to_workspace_without_full_sandbox_grant(db, user_a):
    from agent.tools import files as agent_files
    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    from app.services.workspaces import ensure_default_workspace_directory

    default_directory = await ensure_default_workspace_directory(db, user_a.id)
    session = await _persist(db, ConversationSession(user_id=user_a.id, title="Phase3 测试"))
    token = set_dispatch_session(session.id, session, "phase3-test")
    try:
        result = await agent_files._create_file(
            db, user_a.id, {"files": [{"name": "默认工作区.md", "content": "正文"}]},
        )
        assert result["created_count"] == 1
        assert result["failed_count"] == 0
        assert result["created"][0]["space"] == "workspace"
        assert result["created"][0]["file_id"]
        created = await db.get(File, result["created"][0]["file_id"])
        assert created.workspace_directory_id == default_directory.id

        folder_result = await agent_files._create_folder(
            db, user_a.id, {"name": "默认目录"},
        )
        assert folder_result["success"] is True
        folder = await db.get(Folder, folder_result["folder_id"])
        assert folder.workspace_directory_id == default_directory.id

        listed = await agent_files._list_folders(db, user_a.id, {})
        assert any(item["id"] == folder.id for item in listed)
    finally:
        reset_dispatch_session(token)


@pytest.mark.asyncio
async def test_web_download_checks_write_policy_before_fetching(db, user_a):
    from unittest.mock import AsyncMock, patch

    from agent.tools import web
    from agent.tools.base import reset_dispatch_session, set_dispatch_session

    session = await _persist(db, ConversationSession(user_id=user_a.id, title="Phase3 下载测试"))
    token = set_dispatch_session(session.id, session, "phase3-web-download")
    fetch = AsyncMock()
    try:
        with patch.object(web, "_download_bytes", new=fetch):
            result = await web._web_download(
                db, user_a.id, {"url": "https://example.test/run.py"},
            )
    finally:
        reset_dispatch_session(token)

    assert result["error"].startswith("当前文件系统权限只允许读取")
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_scheduled_task_file_policy_uses_task_subject(db, user_a):
    from agent.tools.base import (
        reset_dispatch_filesystem_subject,
        set_dispatch_filesystem_subject,
    )
    from agent.tools.filesystem_policy import write_access_error
    from app.models import ScheduledTask

    task = await _persist(db, ScheduledTask(
        user_id=user_a.id, name="Phase3 任务", payload="", cron="0 9 * * *",
    ))
    token = set_dispatch_filesystem_subject({
        "subject_type": "scheduled_task", "subject_id": task.id,
    })
    try:
        error = await write_access_error(
            db, user_a.id, space="personal", folder_id=None,
        )
    finally:
        reset_dispatch_filesystem_subject(token)

    assert error is not None and error.startswith("当前文件系统权限只允许读取")


def test_script_path_rejects_absolute_traversal_and_platform_separators():
    from agent.tools.shell import _normalize_script_path

    assert _normalize_script_path("jobs/run.py") == ("workspace", PurePosixPath("jobs/run.py"))
    assert _normalize_script_path("/workspace/jobs/run.py") == (
        "workspace", PurePosixPath("jobs/run.py"),
    )
    assert _normalize_script_path("/personal/F1/run.py") == (
        "personal", PurePosixPath("F1/run.py"),
    )
    for value in ("/tmp/run.py", "/Users/user/run.py", "../run.py", "jobs/../run.py", r"jobs\\run.py", ""):
        with pytest.raises(ValueError):
            _normalize_script_path(value)
    with pytest.raises(ValueError, match="根目录必须与 root 一致"):
        _normalize_script_path("/personal/F1/run.py", root_name="workspace")


def test_script_file_rejects_symlink_and_hardlink(tmp_path):
    from agent.tools.shell import _validate_script_file, _normalize_script_path

    root = tmp_path / "workspace"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (root / "run.py").write_text("print('ok')\n", encoding="utf-8")
    _, relative = _normalize_script_path("run.py")
    assert _validate_script_file(root, relative) == root / "run.py"

    link = root / "link.py"
    try:
        link.symlink_to(outside / "run.py")
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持文件软链接")
    (outside / "run.py").write_text("print('outside')\n", encoding="utf-8")
    with pytest.raises(ValueError, match="软链接"):
        _, relative = _normalize_script_path("link.py")
        _validate_script_file(root, relative)

    hardlink = root / "hard.py"
    try:
        hardlink.hardlink_to(root / "run.py")
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持硬链接")
    with pytest.raises(ValueError, match="硬链接"):
        _, relative = _normalize_script_path("hard.py")
        _validate_script_file(root, relative)
