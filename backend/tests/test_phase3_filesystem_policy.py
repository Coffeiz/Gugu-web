"""PRD-SHELL-4 Phase 3：文件工具与 policy 的边界。

2026-09-11 产品定案：workspace 绑定与完整沙箱授权只约束 Shell，文件工具不再
按绑定拦截；绑定只作为省略目标时的默认落点。本文件覆盖该边界。
"""

import pytest
from pathlib import PurePosixPath
from sqlalchemy import select

from app.models import ConversationSession, File, Folder, Workspace


async def _persist(db, row):
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_bound_session_explicit_targets_are_honored(db, user_a):
    """绑定工作区只提供默认落点；显式 personal/project 目标按参数使用（2026-09-11 产品定案：
    沙箱/工作区围栏只约束 Shell，文件工具不再按绑定拦截）。"""
    personal = await _persist(db, Folder(user_id=user_a.id, name="个人夹"))
    project = await _persist(db, __import__("app.models", fromlist=["Project"]).Project(user_id=user_a.id, name="测试项目"))
    workspace = await _persist(db, Workspace(
        user_id=user_a.id, name="绑定工作区", kind="folder", folder_id=personal.id,
        enabled=True,
    ))
    session = await _persist(db, ConversationSession(user_id=user_a.id, title="绑定会话", source="web"))
    session.workspace_id = workspace.id
    await db.commit()

    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    from agent.tools.files import _resolve_create_location

    token = set_dispatch_session(session.id, session, "test-explicit-target")
    try:
        assert await _resolve_create_location(db, user_a.id, {}) == (
            "personal", None, personal.id, None, None,
        )
        assert await _resolve_create_location(
            db, user_a.id, {"space": "project", "project_id": project.id},
        ) == ("project", project.id, None, None, None)
        assert await _resolve_create_location(
            db, user_a.id, {"folder_id": personal.id},
        ) == ("personal", None, personal.id, None, None)
    finally:
        reset_dispatch_session(token)


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
async def test_agent_copy_keeps_bound_directory_workspace_as_default_with_full_grant(
    db, user_a, tmp_path, monkeypatch, enable_filesystem_authorization,
):
    """完整授权不能把独立 Workspace 的默认复制落点降级到个人文件根目录。"""
    from app.core.config import get_settings
    from agent.tools import files as agent_files
    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    from app.services.filesystem_authorization import grant_session_filesystem_access
    from app.services.storage import LocalStorageBackend
    from app.services.storage.file_service import FileService
    from app.services.workspaces import create_workspace_directory

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))

    directory = await create_workspace_directory(db, user_a.id, name="F1 独立工作区")
    binding = await db.scalar(select(Workspace).where(
        Workspace.user_id == user_a.id,
        Workspace.directory_id == directory.id,
        Workspace.enabled.is_(True),
    ))
    assert binding is not None
    session = await _persist(db, ConversationSession(
        user_id=user_a.id, title="独立 Workspace 复制测试", workspace_id=binding.id,
    ))
    await grant_session_filesystem_access(db, user_a.id, session.id)
    await db.commit()

    source_service = FileService(db, storage=LocalStorageBackend(tmp_path))
    source = await source_service.create_file(
        user_a.id, space="personal", project_id=None, folder_id=None,
        stage_name="", mind_map_id=None, display_name="F1 图表", ext="png",
        mime_type="image/png", data=b"image",
    )
    await db.commit()

    token = set_dispatch_session(session.id, session, "phase3-independent-workspace-copy")
    try:
        result = await agent_files._copy_file(db, user_a.id, {"file_id": source.file.id})
    finally:
        reset_dispatch_session(token)

    assert result["success"] is True
    copied = await db.get(File, result["file_id"])
    assert copied is not None
    assert copied.space == "workspace"
    assert copied.workspace_directory_id == directory.id
    assert copied.storage_key != source.file.storage_key
    assert f"/{directory.directory_name}/" in f"/{copied.storage_key}/"
    assert "个人文件" not in copied.storage_key

    # 删除个人源文件只能移动源文件自己的 key，不能把 Workspace 副本一起移走。
    token = set_dispatch_session(session.id, session, "phase3-independent-workspace-delete")
    try:
        deleted = await agent_files._delete_file(db, user_a.id, {"file_id": source.file.id})
    finally:
        reset_dispatch_session(token)
    assert deleted["success"] is True
    await db.refresh(copied)
    assert copied.deleted_at is None
    assert await source_service.storage.exists(copied.storage_key)


@pytest.mark.asyncio
async def test_web_download_not_blocked_by_workspace_binding(db, user_a):
    """下载落库属于文件工具，不再按 workspace 绑定拦截：没有完整沙箱授权的会话
    也应把请求发出去（2026-09-11 产品定案，围栏只约束 Shell）。"""
    from unittest.mock import AsyncMock, patch

    from agent.tools import web
    from agent.tools.base import reset_dispatch_session, set_dispatch_session

    session = await _persist(db, ConversationSession(user_id=user_a.id, title="Phase3 下载测试"))
    token = set_dispatch_session(session.id, session, "phase3-web-download")
    fetch = AsyncMock(return_value=(500, {}, b""))
    try:
        with patch.object(web, "_download_bytes", new=fetch):
            result = await web._web_download(
                db, user_a.id, {"url": "https://example.test/run.py"},
            )
    finally:
        reset_dispatch_session(token)

    fetch.assert_awaited()
    assert result["error"].startswith("下载失败")


@pytest.mark.asyncio
async def test_bound_session_writes_outside_workspace(db, user_a, tmp_path, monkeypatch):
    """绑定 workspace 的会话仍可 create/delete 个人空间文件——绑定只给默认落点。"""
    from app.core.config import get_settings
    from agent.tools import files as agent_files
    from agent.tools.base import reset_dispatch_session, set_dispatch_session
    from app.services.storage import LocalStorageBackend
    from app.services.storage.file_service import FileService

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    monkeypatch.setattr(settings.storage, "local_path", str(tmp_path))

    own = await _persist(db, Folder(user_id=user_a.id, name="个人根夹"))
    workspace = await _persist(db, Workspace(
        user_id=user_a.id, name="绑定工作区", kind="folder", folder_id=own.id,
        enabled=True,
    ))
    session = await _persist(db, ConversationSession(user_id=user_a.id, title="越界写测试"))
    session.workspace_id = workspace.id
    await db.commit()

    outside_service = FileService(db, storage=LocalStorageBackend(tmp_path))
    outside = await outside_service.create_file(
        user_a.id, space="personal", project_id=None, folder_id=None,
        stage_name="", mind_map_id=None, display_name="绑定外文件", ext="md",
        mime_type="text/markdown", data="正文".encode(),
    )
    await db.commit()

    token = set_dispatch_session(session.id, session, "phase3-bound-outside-write")
    try:
        renamed = await agent_files._rename_file(
            db, user_a.id, {"file_id": outside.file.id, "new_name": "绑定外改名"},
        )
        assert renamed.get("success") is True, renamed
        deleted = await agent_files._delete_file(db, user_a.id, {"file_id": outside.file.id})
        assert deleted.get("success") is True, deleted
    finally:
        reset_dispatch_session(token)
    await db.refresh(outside.file)
    assert outside.file.deleted_at is not None


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
