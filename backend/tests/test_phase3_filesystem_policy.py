"""PRD-SHELL-4 Phase 3：文件工具策略复用与显式脚本边界。"""

import pytest

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
async def test_full_grant_allows_personal_and_project_file_writes(db, user_a):
    policy = FilesystemPolicy(personal_read_only=False, project_read_only=False)

    assert await filesystem_location_can_write(
        db, user_a.id, policy, space="personal", folder_id=None,
    )
    assert await filesystem_location_can_write(
        db, user_a.id, policy, space="project", project_id=999, folder_id=None,
    )


@pytest.mark.asyncio
async def test_agent_file_create_is_read_only_without_session_grant(db, user_a):
    from agent.tools import files as agent_files
    from agent.tools.base import reset_dispatch_session, set_dispatch_session

    session = await _persist(db, ConversationSession(user_id=user_a.id, title="Phase3 测试"))
    token = set_dispatch_session(session.id, session, "phase3-test")
    try:
        result = await agent_files._create_document(
            db, user_a.id, {"name": "禁止写入", "format": "md", "content": "正文"},
        )
    finally:
        reset_dispatch_session(token)

    assert result["error"].startswith("当前文件系统权限只允许读取")


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

    assert _normalize_script_path("jobs/run.py").as_posix() == "jobs/run.py"
    for value in ("/tmp/run.py", "../run.py", "jobs/../run.py", r"jobs\\run.py", ""):
        with pytest.raises(ValueError, match="沙盒内的相对路径"):
            _normalize_script_path(value)


def test_script_file_rejects_symlink_and_hardlink(tmp_path):
    from agent.tools.shell import _validate_script_file, _normalize_script_path

    root = tmp_path / "workspace"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (root / "run.py").write_text("print('ok')\n", encoding="utf-8")
    assert _validate_script_file(root, _normalize_script_path("run.py")) == root / "run.py"

    link = root / "link.py"
    try:
        link.symlink_to(outside / "run.py")
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持文件软链接")
    (outside / "run.py").write_text("print('outside')\n", encoding="utf-8")
    with pytest.raises(ValueError, match="软链接"):
        _validate_script_file(root, _normalize_script_path("link.py"))

    hardlink = root / "hard.py"
    try:
        hardlink.hardlink_to(root / "run.py")
    except (NotImplementedError, OSError):
        pytest.skip("当前平台不支持硬链接")
    with pytest.raises(ValueError, match="硬链接"):
        _validate_script_file(root, _normalize_script_path("hard.py"))
