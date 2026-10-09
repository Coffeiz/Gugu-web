import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.config import FileSyncSettings
from app.models import (
    ConversationSession,
    File,
    FileSyncBinding,
    FileSyncConflict,
    FileSyncJournal,
    Folder,
    Project,
    StorageQuotaLedger,
    Workspace,
)
from app.services.filesync import (
    FileSyncDisabled,
    build_idempotency_key,
    create_binding,
    normalize_relative_path,
    record_change,
    validate_sync_path,
    dry_run_local_binding,
    sync_local_binding,
    resolve_sync_conflict,
    enqueue_file_event,
    deliver_file_event,
)


def test_sync_path_is_normalized_and_confined(tmp_path):
    assert normalize_relative_path("./reports//today.txt") == "reports/today.txt"
    assert validate_sync_path(tmp_path, "reports/today.txt") == tmp_path / "reports" / "today.txt"
    with pytest.raises(ValueError, match="越界"):
        normalize_relative_path("../outside.txt")
    with pytest.raises(ValueError, match="相对路径"):
        normalize_relative_path("/etc/passwd")


def test_sync_path_rejects_symlink_escape(tmp_path):
    outside = tmp_path.parent / "filesync-outside"
    outside.mkdir()
    (tmp_path / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="越界"):
        validate_sync_path(tmp_path, "link/secret.txt")


def test_stable_fingerprint_marks_concurrent_write_as_transient(tmp_path, monkeypatch):
    """哈希前后文件变化要被识别为临时写入，不混入非法路径计数。"""
    import app.services.filesync.reconcile as reconcile

    path = tmp_path / "changing.txt"
    path.write_text("before", encoding="utf-8")
    fingerprint = reconcile._fingerprint

    def change_after_read(target, **kwargs):
        digest = fingerprint(target, **kwargs)
        target.write_text("after write", encoding="utf-8")
        return digest

    monkeypatch.setattr(reconcile, "_fingerprint", change_after_read)
    with pytest.raises(reconcile.FileChangedDuringRead):
        reconcile._stable_fingerprint(path)


def test_filesync_is_enabled_by_default():
    assert FileSyncSettings().enabled is True


@pytest.mark.asyncio
async def test_phase1_protocol_respects_explicit_disabled_setting(db, user_a, monkeypatch):
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(
        protocol,
        "get_settings",
        lambda: SimpleNamespace(
            filesync=SimpleNamespace(enabled=False),
            storage=SimpleNamespace(backend="local"),
        ),
    )
    with pytest.raises(FileSyncDisabled):
        await create_binding(db, user_id=user_a.id, source="local_directory", root_fingerprint="a" * 64)


@pytest.mark.asyncio
async def test_canonical_file_change_is_noop_when_filesync_is_disabled_or_remote(
    db, user_a, monkeypatch, tmp_path,
):
    import app.services.filesync.protocol as protocol

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=False),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    await protocol.record_canonical_file_change(
        db,
        user_id=user_a.id,
        storage_key=f"{user_a.id}/个人文件/note.md",
        observed_fingerprint="a" * 64,
    )

    settings.filesync.enabled = True
    settings.storage.backend = "oss"
    await protocol.record_canonical_file_change(
        db,
        user_id=user_a.id,
        storage_key=f"{user_a.id}/个人文件/note.md",
        observed_fingerprint="b" * 64,
    )
    assert (await db.scalars(select(FileSyncJournal))).all() == []


@pytest.mark.asyncio
async def test_canonical_workspace_change_uses_resolved_workspace_root(
    db, user_a, monkeypatch, tmp_path,
):
    import app.services.filesync.protocol as protocol
    import app.services.workspaces as workspaces

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(workspaces, "get_settings", lambda: settings)

    project = Project(user_id=user_a.id, name="同步项目", start_date="2026-03-15")
    db.add(project)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="项目工作区", kind="project",
        project_id=project.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id,
        source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()

    await protocol.record_canonical_file_change(
        db,
        user_id=user_a.id,
        storage_key=f"{user_a.id}/项目文件/2026/03/同步项目 #{project.id}/foo.md",
        observed_fingerprint="b" * 64,
    )

    journal = (await db.scalars(select(FileSyncJournal))).one()
    assert journal.binding_id == binding.id
    assert journal.relative_path == "foo.md"


@pytest.mark.asyncio
async def test_journal_is_idempotent_and_advances_revision(db, user_a, monkeypatch):
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    binding = await create_binding(
        db, user_id=user_a.id, source="local_directory", root_fingerprint="a" * 64,
    )
    key = build_idempotency_key(
        source="local_directory", operation="create", relative_path="reports/a.txt", fingerprint="b" * 64,
    )
    first = await record_change(
        db, binding=binding, user_id=user_a.id, source="local_directory", operation="create",
        relative_path="reports/a.txt", idempotency_key=key, observed_fingerprint="b" * 64,
    )
    second = await record_change(
        db, binding=binding, user_id=user_a.id, source="local_directory", operation="create",
        relative_path="reports/a.txt", idempotency_key=key, observed_fingerprint="b" * 64,
    )
    await db.commit()
    rows = (await db.scalars(select(FileSyncJournal))).all()
    assert first.id == second.id
    assert len(rows) == 1
    assert rows[0].revision == 1
    assert binding.revision == 1


@pytest.mark.asyncio
async def test_oss_does_not_expose_or_bind_workspace(db, user_a, monkeypatch):
    import app.services.workspaces as workspaces

    settings = SimpleNamespace(storage=SimpleNamespace(backend="oss"))
    monkeypatch.setattr(workspaces, "get_settings", lambda: settings)
    assert await workspaces.list_workspaces(db, user_a.id) == []
    with pytest.raises(ValueError, match="OSS"):
        await workspaces.create_workspace(
            db, user_a.id, name="不应绑定", kind="project", project_id=999,
        )


@pytest.mark.asyncio
async def test_migrated_known_workspace_file_is_reconciled_into_its_folder(db, user_a, monkeypatch, tmp_path):
    """迁移后按已有 storage_key 重新投影，修复旧记录漏掉的文件夹归属。"""
    from app.models import Folder, WorkspaceDirectory
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.workspaces as workspaces
    from scripts.migrations.migrate_workspace_layout import migrate

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        quota=SimpleNamespace(default_storage_limit_bytes=1024 * 1024),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(workspaces, "get_settings", lambda: settings)

    directory = WorkspaceDirectory(
        user_id=user_a.id, name="默认工作区", directory_name="workspace",
        is_default=True, is_system=True,
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name=directory.name, kind="directory",
        directory_id=directory.id, enabled=True,
    )
    folder = Folder(
        user_id=user_a.id, name="package", workspace_directory_id=directory.id,
    )
    db.add_all([workspace, folder])
    await db.flush()

    old_root = tmp_path / str(user_a.id) / "workspace"
    package = old_root / "package"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("# probe", encoding="utf-8")
    row = File(
        user_id=user_a.id, display_name="__init__", ext="py", space="workspace",
        workspace_directory_id=directory.id, folder_id=None,
        storage_key=f"{user_a.id}/workspace/package/__init__.py",
        size="7", size_bytes=7, storage_backend="local",
    )
    db.add(row)
    await db.commit()

    migration = await migrate(db, tmp_path, apply=True)
    assert migration["status"] == "completed"
    assert row.storage_key == f"{user_a.id}/workspace/default/package/__init__.py"
    assert row.folder_id is None

    summary = await reconcile.reconcile_local_directory(
        db, user_a.id, workspace_id=workspace.id,
        allow_delete=False, dry_run=True, use_stat_cache=False,
    )
    assert summary.updated == 1
    assert row.folder_id == folder.id

    version = row.version
    second = await reconcile.reconcile_local_directory(
        db, user_a.id, workspace_id=workspace.id,
        allow_delete=False, dry_run=True, use_stat_cache=False,
    )
    assert second.updated == 0
    assert row.version == version


@pytest.mark.asyncio
async def test_oss_session_workspace_is_rejected_by_shell_policy(db, user_a, monkeypatch):
    import agent.security.shell_policy as policy

    session = ConversationSession(user_id=user_a.id, title="同步测试")
    db.add(session)
    await db.flush()
    session.workspace_id = 123
    await db.commit()
    settings = SimpleNamespace(
        storage=SimpleNamespace(backend="oss"),
        agent=SimpleNamespace(shell_enabled=True, shell_system_enabled=False),
        sandbox=SimpleNamespace(enabled=True, full_user_sandbox_authorization_enabled=True),
    )
    monkeypatch.setattr(policy, "get_settings", lambda: settings)
    monkeypatch.setattr(policy, "workspace_shell_supported", lambda: False)
    decision = await policy.evaluate(db, user_a.id, session.id, "pwd", session=session)
    assert decision.allowed is False
    assert "OSS" in decision.reason


@pytest.mark.asyncio
async def test_local_reconcile_projects_create_update_move_and_delete(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path)))
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    file_path = root / "before.txt"
    file_path.write_text("hello", encoding="utf-8")
    first = await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert first.created == 1
    (await db.scalars(select(FileSyncBinding))).one()
    file_row = (await db.scalars(select(File))).one()
    first_version = file_row.version

    file_path.write_text("world", encoding="utf-8")
    second = await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert second.updated == 1
    assert file_row.version == first_version + 1

    moved_path = root / "after.txt"
    file_path.rename(moved_path)
    third = await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert third.moved == 1
    assert file_row.storage_key.endswith("after.txt")

    moved_path.unlink()
    fourth = await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    assert fourth.deleted == 1
    assert file_row.deleted_at is not None


@pytest.mark.asyncio
async def test_full_reconcile_does_not_count_shell_files_against_file_library_quota(
    db, user_a, monkeypatch, tmp_path,
):
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(reconcile, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
        quota=SimpleNamespace(default_storage_limit_bytes=None),
    ))
    user_a.storage_limit_bytes = 16
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "small.txt").write_bytes(b"12345678")
    shell_root = tmp_path / str(user_a.id) / "workspace"
    shell_root.mkdir(parents=True)
    (shell_root / "build.cache").write_bytes(b"x" * 128)

    summary = await reconcile.reconcile_local_directory(db, user_a.id, root=root)
    await db.commit()

    assert summary.created == 1
    assert summary.rejected == 0


@pytest.mark.asyncio
async def test_full_reconcile_none_limits_mean_unlimited(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(reconcile, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
        quota=SimpleNamespace(default_storage_limit_bytes=None),
    ))
    user_a.storage_limit_bytes = None
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "new.bin").write_bytes(b"x" * 32)

    summary = await reconcile.reconcile_local_directory(db, user_a.id, root=root)
    await db.commit()

    assert summary.created == 1
    assert summary.rejected == 0


@pytest.mark.asyncio
async def test_full_reconcile_projects_deletions_before_admitting_new_files(
    db, user_a, monkeypatch, tmp_path,
):
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(reconcile, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
        quota=SimpleNamespace(default_storage_limit_bytes=None),
    ))
    user_a.storage_limit_bytes = 8
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    old_path = root / "old.bin"
    old_path.write_bytes(b"o" * 8)
    await reconcile.reconcile_local_directory(db, user_a.id, root=root)
    await db.commit()

    old_path.unlink()
    (root / "new.bin").write_bytes(b"n" * 8)
    summary = await reconcile.reconcile_local_directory(db, user_a.id, root=root)
    await db.commit()

    assert summary.created == 1
    assert summary.deleted == 1
    assert summary.rejected == 0


@pytest.mark.asyncio
async def test_local_reconcile_projects_directory_workspace_shell_files(db, user_a, monkeypatch, tmp_path):
    """directory 型工作区绑定根即工作区目录：shell 产物按 space=workspace 投影。

    真实故障：_classify_path/_parse_directory_path 只认个人/项目 canonical 前缀，
    workspace/<directory_name>/ 下的 shell 产物（如 _tools/）整树被拒，文件库
    永远看不到咕咕 shell 写入的文件夹。
    """
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.workspaces as workspaces
    from app.models import Folder, WorkspaceDirectory

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(workspaces, "get_settings", lambda: settings)

    directory = WorkspaceDirectory(
        user_id=user_a.id, name="探针工作区", directory_name="workspace-probe",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="目录工作区", kind="directory",
        directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()

    ws_root = tmp_path / str(user_a.id) / "workspace" / "workspace-probe"
    tools_dir = ws_root / "_tools"
    (tools_dir / "bin").mkdir(parents=True)
    (tools_dir / "empty").mkdir()
    (tools_dir / "bin" / "run.py").write_text("print('ok')", encoding="utf-8")
    (ws_root / "_gen_weather.py").write_text("print('w')", encoding="utf-8")

    summary = await reconcile.reconcile_local_directory(db, user_a.id, workspace_id=workspace.id)
    await db.commit()

    # shell 文件夹（含空目录）与文件都按 workspace 空间落库
    assert summary.folders_created >= 2
    assert summary.created >= 2
    tools = (await db.scalars(select(Folder).where(
        Folder.user_id == user_a.id, Folder.name == "_tools",
        Folder.workspace_directory_id == directory.id,
    ))).one()
    assert tools.parent_id is None
    bin_folder = (await db.scalars(select(Folder).where(
        Folder.parent_id == tools.id, Folder.name == "bin",
    ))).one()
    assert bin_folder.workspace_directory_id == directory.id
    gen_file = (await db.scalars(select(File).where(
        File.user_id == user_a.id, File.display_name == "_gen_weather",
        File.ext == "py",
    ))).one()
    assert gen_file.space == "workspace"
    assert gen_file.workspace_directory_id == directory.id
    assert gen_file.folder_id is None


@pytest.mark.asyncio
async def test_local_reconcile_skips_dirty_storage_key_without_aborting(db, user_a, monkeypatch, tmp_path):
    """存量双斜杠 storage_key 去前缀后仍是绝对路径，不能中断整轮投影。"""
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path)))
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "kept.txt").write_text("kept", encoding="utf-8")
    dirty = File(
        user_id=user_a.id, display_name="dirty.txt", ext="txt", space="personal",
        stage_name="", storage_key=f"{user_a.id}//dirty.txt",
        storage_backend="local", size="4", size_bytes=4,
    )
    db.add(dirty)
    await db.commit()

    summary = await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()

    # 脏行被当作 rejected 跳过，正常文件照常投影，不再抛 ValueError
    assert summary.created == 1
    assert summary.rejected >= 1
    await db.refresh(dirty)
    assert dirty.deleted_at is None


@pytest.mark.asyncio
async def test_phase3_binding_requires_dry_run_then_explicit_apply(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(bindings, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(
        bindings, "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )
    monkeypatch.setattr(
        reconcile, "get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path))),
    )

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "draft.txt").write_text("draft", encoding="utf-8")

    preview = await dry_run_local_binding(
        db, user_a.id, root_path="个人文件", mode="mirror_in",
    )
    assert preview.dry_run is True
    assert preview.binding_id is None
    assert preview.conflict_ids == ()
    assert preview.summary.created == 1
    assert (await db.scalars(select(FileSyncBinding))).all() == []
    assert (await db.scalars(select(File))).all() == []

    applied = await sync_local_binding(
        db, user_a.id, root_path="个人文件", mode="mirror_in",
    )
    await db.commit()
    assert applied.dry_run is False
    assert applied.summary.created == 1
    binding = (await db.scalars(select(FileSyncBinding))).one()
    assert binding.root_path == "个人文件"


@pytest.mark.asyncio
async def test_phase3_mirror_out_dry_run_does_not_copy(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    from app.services.storage import LocalStorageBackend

    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
            storage=SimpleNamespace(local_path=str(tmp_path)),
        ))
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(bindings, "get_storage", lambda: LocalStorageBackend(tmp_path))
    source_root = tmp_path / str(user_a.id) / "个人文件"
    source_root.mkdir(parents=True)
    (source_root / "report.txt").write_text("report", encoding="utf-8")
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="mirror_in")
    await db.commit()
    export_root = tmp_path / str(user_a.id) / "export"
    export_root.mkdir()

    preview = await dry_run_local_binding(
        db, user_a.id, root_path="export", mode="mirror_out",
    )
    assert preview.summary.updated == 1
    assert not (export_root / "个人文件" / "report.txt").exists()


@pytest.mark.asyncio
async def test_phase3_mirror_out_never_soft_deletes_missing_db_files(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    from app.services.storage import LocalStorageBackend

    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
            storage=SimpleNamespace(local_path=str(tmp_path)),
        ))
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(bindings, "get_storage", lambda: LocalStorageBackend(tmp_path))
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "kept.txt").write_text("kept", encoding="utf-8")
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="mirror_in")
    await db.commit()
    row = (await db.scalars(select(File))).one()
    (root / "kept.txt").unlink()

    result = await sync_local_binding(
        db, user_a.id, root_path="个人文件", mode="mirror_out",
    )
    await db.commit()
    assert result.summary.rejected == 1
    assert row.deleted_at is None


@pytest.mark.asyncio
async def test_phase3_mirror_out_copies_db_objects_to_bound_directory(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    from app.services.storage import LocalStorageBackend

    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
            storage=SimpleNamespace(local_path=str(tmp_path)),
        ))
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(bindings, "get_storage", lambda: LocalStorageBackend(tmp_path))
    monkeypatch.setattr(snapshots, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))
    source_root = tmp_path / str(user_a.id) / "个人文件"
    source_root.mkdir(parents=True)
    (source_root / "report.txt").write_text("report", encoding="utf-8")
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="mirror_in")
    await db.commit()

    export_root = tmp_path / str(user_a.id) / "export"
    export_root.mkdir()
    result = await sync_local_binding(
        db, user_a.id, root_path="export", mode="mirror_out",
    )
    await db.commit()
    assert result.summary.updated == 1
    assert (export_root / "个人文件" / "report.txt").read_text(encoding="utf-8") == "report"


@pytest.mark.asyncio
async def test_phase3_bidirectional_changes_after_baseline_create_conflict(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots

    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
            storage=SimpleNamespace(local_path=str(tmp_path)),
        ))
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(snapshots, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "conflict.txt"
    path.write_text("baseline", encoding="utf-8")
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="bidirectional")
    await db.commit()
    row = (await db.scalars(select(File))).one()
    path.write_text("local change", encoding="utf-8")
    row.updated_at = __import__("app.core.tz", fromlist=["now_utc"]).now_utc()
    await db.flush()

    result = await sync_local_binding(
        db, user_a.id, root_path="个人文件", mode="bidirectional",
    )
    await db.commit()
    assert result.summary.conflicts == 1
    assert result.summary.updated == 0
    conflict = (await db.scalars(select(FileSyncConflict))).one()
    assert conflict.status == "pending"
    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_local")
    await db.commit()
    assert conflict.status == "resolved"
    assert path.read_text(encoding="utf-8") == "local change"


@pytest.mark.asyncio
async def test_keep_local_advances_baseline_when_watcher_already_journaled_same_fingerprint(
    db, user_a, monkeypatch, tmp_path,
):
    """保留本地必须新增冲突决策基线，避免复用旧 watcher journal 后原冲突重现。"""
    from datetime import timedelta

    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.snapshots as snapshots
    from app.core.tz import now_utc

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    for module in (bindings, reconcile, protocol, snapshots):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(snapshots, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "conflict.txt"
    path.write_text("baseline", encoding="utf-8")
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="bidirectional")
    await db.commit()
    row = (await db.scalars(select(File))).one()
    binding = (await db.scalars(select(FileSyncBinding))).one()

    path.write_text("local change", encoding="utf-8")
    local_fingerprint = hashlib.sha256(b"local change").hexdigest()
    remote_fingerprint = hashlib.sha256(b"remote change").hexdigest()
    # watcher 已经为本地这个指纹写过 journal；稍后文件库端发生更新并成为最新 journal。
    await record_change(
        db, binding=binding, user_id=user_a.id, source="local_directory", operation="update",
        relative_path="conflict.txt",
        idempotency_key=build_idempotency_key(
            source="local_directory", operation="update", relative_path="conflict.txt",
            fingerprint=local_fingerprint,
        ), observed_fingerprint=local_fingerprint, status="synced",
    )
    await db.commit()
    await record_change(
        db, binding=binding, user_id=user_a.id, source="file_api", operation="update",
        relative_path="conflict.txt",
        idempotency_key=build_idempotency_key(
            source="file_api", operation="update", relative_path="conflict.txt",
            fingerprint=remote_fingerprint,
        ), observed_fingerprint=remote_fingerprint, status="synced",
    )
    row.updated_at = now_utc() + timedelta(seconds=1)
    await db.commit()

    conflict_ids = await bindings._pending_conflicts(db, user_a.id, binding, root)
    await db.commit()
    assert len(conflict_ids) == 1
    conflict = await db.get(FileSyncConflict, conflict_ids[0])
    assert conflict is not None

    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_local")
    await db.commit()

    recreated = await bindings._pending_conflicts(db, user_a.id, binding, root)
    assert recreated == ()
    journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.relative_path == "conflict.txt",
        FileSyncJournal.status == "synced",
    ).order_by(FileSyncJournal.id.desc()))).all()
    assert journals[0].observed_fingerprint == local_fingerprint
    assert journals[0].id != journals[-1].id


@pytest.mark.asyncio
async def test_keep_local_uses_workspace_root_and_prevents_reconcile_conflict_reappearing(
    db, user_a, monkeypatch, tmp_path,
):
    """workspace 绑定必须在正确目录记录本地基线，避免再次对账重复报冲突。"""
    from datetime import timedelta

    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.snapshots as snapshots
    import app.services.workspaces as workspaces

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    for module in (bindings, protocol, reconcile, snapshots, workspaces):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(snapshots, "get_settings", lambda: settings)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)

    project = Project(user_id=user_a.id, name="本地优先测试", start_date="2026-10-01")
    db.add(project)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="项目工作区", kind="project",
        project_id=project.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id,
        source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64, mode="bidirectional",
    )
    db.add(binding)
    await db.flush()

    root = await workspaces.resolve_workspace_root(db, user_a.id, workspace.id)
    assert root is not None
    relative = "guide.md"
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("local version", encoding="utf-8")
    local_fingerprint = hashlib.sha256(b"local version").hexdigest()
    file_row = File(
        user_id=user_a.id, display_name="guide", ext="md", space="project",
        project_id=project.id, storage_key=f"{user_a.id}/{root.relative_to(tmp_path / str(user_a.id)).as_posix()}/{relative}",
        size="13", size_bytes=13, storage_backend="local",
    )
    db.add(file_row)
    await db.flush()
    remote_journal = await record_change(
        db, binding=binding, user_id=user_a.id, source="file_api", operation="update",
        relative_path=relative,
        idempotency_key=build_idempotency_key(
            source="file_api", operation="update", relative_path=relative,
            fingerprint="b" * 64,
        ), observed_fingerprint="b" * 64, status="synced",
    )
    file_row.updated_at = remote_journal.updated_at + timedelta(microseconds=1)
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path=relative,
        source="local_directory", baseline_fingerprint="b" * 64,
        local_fingerprint=local_fingerprint, remote_fingerprint="b" * 64,
        status="pending",
    )
    db.add(conflict)
    await db.commit()

    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_local")
    await db.commit()

    assert conflict.status == "resolved"
    assert conflict.resolution == "keep_local"
    assert snapshots.snapshot_fingerprint(user_a.id, binding.id, relative) == local_fingerprint
    journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.relative_path == relative,
    ).order_by(FileSyncJournal.id.desc()))).all()
    assert journals[0].observed_fingerprint == local_fingerprint
    assert journals[0].updated_at >= file_row.updated_at
    assert await bindings._pending_conflicts(db, user_a.id, binding, root) == ()


@pytest.mark.asyncio
async def test_phase3_conflict_keep_remote_and_keep_both_apply_snapshot(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots

    for module in (bindings, reconcile):
        monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
            storage=SimpleNamespace(local_path=str(tmp_path)),
        ))
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(snapshots, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "conflict.txt"
    path.write_text("baseline", encoding="utf-8")
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="bidirectional")
    await db.commit()
    row = (await db.scalars(select(File))).one()
    path.write_text("local change", encoding="utf-8")
    row.updated_at = __import__("app.core.tz", fromlist=["now_utc"]).now_utc()
    await db.flush()
    result = await sync_local_binding(db, user_a.id, root_path="个人文件", mode="bidirectional")
    await db.commit()
    conflict = (await db.scalars(select(FileSyncConflict))).one()
    assert result.summary.conflicts == 1

    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_remote")
    await db.commit()
    assert path.read_text(encoding="utf-8") == "baseline"

    path.write_text("local second", encoding="utf-8")
    row.updated_at = __import__("app.core.tz", fromlist=["now_utc"]).now_utc()
    await db.flush()
    await sync_local_binding(db, user_a.id, root_path="个人文件", mode="bidirectional")
    await db.commit()
    conflict = (await db.scalars(select(FileSyncConflict).where(FileSyncConflict.status == "pending"))).one()
    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_both")
    await db.commit()
    assert (root / "conflict (remote).txt").read_text(encoding="utf-8") == "baseline"


@pytest.mark.asyncio
async def test_filesync_event_outbox_retries_and_preserves_event_id(db, user_a, monkeypatch):
    import app.services.filesync.outbox as outbox

    row = await enqueue_file_event(
        db, user_a.id, operation="refresh", entity_ids=(7,), source="local_directory",
    )
    await db.commit()
    published = []

    async def publish(*args, **kwargs):
        published.append((args, kwargs))
        return True

    monkeypatch.setattr(outbox.events, "publish", publish)
    assert await deliver_file_event(db, row) is True
    await db.commit()
    assert row.status == "delivered"
    assert published[0][1]["event_id"] == row.event_id
    assert published[0][1]["entity_ids"] == [7]
    assert published[0][1]["source"] == "local_directory"


@pytest.mark.asyncio
async def test_reconcile_stat_cache_skips_rehash(db, user_a, monkeypatch, tmp_path):
    """size+mtime 未变的已知文件走快路径，不重复整文件哈希；强制关闭时恢复全量哈希。"""
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.statcache as statcache

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(statcache, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "kept.txt").write_text("kept", encoding="utf-8")

    first = await reconcile.reconcile_local_directory(db, user_a.id, use_stat_cache=True)
    await db.commit()
    assert first.created == 1

    calls = {"count": 0}
    real_fingerprint = reconcile._fingerprint

    def counting_fingerprint(path, **kwargs):
        calls["count"] += 1
        return real_fingerprint(path, **kwargs)

    monkeypatch.setattr(reconcile, "_fingerprint", counting_fingerprint)
    second = await reconcile.reconcile_local_directory(db, user_a.id, use_stat_cache=True)
    await db.commit()
    assert second.created == 0 and second.updated == 0
    assert calls["count"] == 0  # 快路径命中，未重新哈希

    forced = await reconcile.reconcile_local_directory(db, user_a.id, use_stat_cache=False)
    await db.commit()
    assert forced.created == 0 and forced.updated == 0
    assert calls["count"] >= 1  # 日级兜底强制全量哈希


async def _prepare_targeted_personal_binding(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.statcache as statcache
    import app.services.filesync.targeted as targeted

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(statcache, "get_settings", lambda: settings)
    monkeypatch.setattr(targeted, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "base.txt").write_text("base", encoding="utf-8")
    await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    binding = (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_a.id,
    ))).one()
    return reconcile, targeted, root, binding


@pytest.mark.asyncio
async def test_targeted_projection_handles_create_update_move_delete(db, user_a, monkeypatch, tmp_path):
    """sidecar 精确事件按路径单点投影：创建/更新/移动重挂/软删除/空目录。"""
    reconcile, targeted, root, binding = await _prepare_targeted_personal_binding(
        db, user_a, monkeypatch, tmp_path,
    )

    # watcher 读取事件时文件还在变化，或随后被删除：过期/中间态不应把绑定降级；
    # 随后的精确删除事件仍须正常软删除已有 File 行。
    with monkeypatch.context() as changing_read:
        changing_read.setattr(
            targeted,
            "_stable_fingerprint",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                reconcile.FileChangedDuringRead("合成的并发写入")
            ),
        )
        transient = await targeted.project_path_events(
            db, user_a.id, binding, root, targeted.PathEventBatch(changed={"base.txt"}),
        )
    assert transient.rejected == 0
    assert transient.rejection_reasons == ()

    base_file = (await db.scalars(select(File).where(
        File.user_id == user_a.id, File.storage_key.endswith("/个人文件/base.txt"),
    ))).one()
    (root / "base.txt").unlink()
    stale = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"base.txt"}),
    )
    assert stale.rejected == 0
    deleted_summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(deleted={"base.txt"}),
    )
    await db.commit()
    await db.refresh(base_file)
    assert deleted_summary.deleted == 1
    assert base_file.deleted_at is not None

    # 创建
    (root / "new.txt").write_text("v1", encoding="utf-8")
    batch = targeted.PathEventBatch(changed={"new.txt"})
    summary = await targeted.project_path_events(db, user_a.id, binding, root, batch)
    await db.commit()
    assert summary.created == 1
    created = (await db.scalars(select(File).where(
        File.user_id == user_a.id, File.display_name == "new", File.ext == "txt",
        File.deleted_at.is_(None),
    ))).one()
    original_id = created.id
    original_version = created.version

    # 等长且 mtime 不变的更新，也必须重新核对正文。
    import os
    previous_stat = (root / "new.txt").stat()
    (root / "new.txt").write_text("v2", encoding="utf-8")
    os.utime(root / "new.txt", ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns))
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"new.txt"}),
    )
    await db.commit()
    assert summary.updated == 1
    updated = await db.get(File, original_id)
    await db.refresh(updated)
    assert updated.size_bytes == len("v2")
    assert updated.version == original_version + 1

    # 改名 = unlink+add：同指纹且原路径已消失 → 移动重挂，不删旧建新
    (root / "new.txt").rename(root / "moved.txt")
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(changed={"moved.txt"}, deleted={"new.txt"}),
    )
    await db.commit()
    assert summary.moved == 1 and summary.deleted == 0 and summary.created == 0
    moved = await db.get(File, original_id)
    await db.refresh(moved)
    assert moved.storage_key.endswith("moved.txt")

    # 软删除
    (root / "moved.txt").unlink()
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(deleted={"moved.txt"}),
    )
    await db.commit()
    assert summary.deleted == 1
    deleted = await db.get(File, original_id)
    await db.refresh(deleted)
    assert deleted.deleted_at is not None

    # 空目录：创建 → 删除
    (root / "sub").mkdir()
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(folders_created={"sub"}),
    )
    await db.commit()
    assert summary.folders_created == 1
    # 过期 unlinkDir 到达时物理目录已重建，不能把新目录软删除。
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(folders_deleted={"sub"}),
    )
    await db.commit()
    assert summary.folders_deleted == 0
    still_active = (await db.scalars(select(Folder).where(
        Folder.user_id == user_a.id, Folder.name == "sub", Folder.deleted_at.is_(None),
    ))).one()
    assert still_active.deleted_at is None

    (root / "sub").rmdir()
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(folders_deleted={"sub"}),
    )
    await db.commit()
    assert summary.folders_deleted == 1


@pytest.mark.asyncio
async def test_same_fingerprint_does_not_guess_between_multiple_file_moves(
    db, user_a, monkeypatch, tmp_path,
):
    _, targeted, root, binding = await _prepare_targeted_personal_binding(
        db, user_a, monkeypatch, tmp_path,
    )
    for name in ("same-a.txt", "same-b.txt"):
        (root / name).write_text("same payload", encoding="utf-8")
    await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(changed={"same-a.txt", "same-b.txt"}),
    )
    await db.commit()
    old_rows = list((await db.scalars(select(File).where(
        File.user_id == user_a.id,
        File.storage_key.in_({
            f"{user_a.id}/个人文件/same-a.txt",
            f"{user_a.id}/个人文件/same-b.txt",
        }),
        File.deleted_at.is_(None),
    ))).all())
    old_ids = {row.id for row in old_rows}

    (root / "same-a.txt").rename(root / "same-c.txt")
    (root / "same-b.txt").rename(root / "same-d.txt")
    result = await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(
            changed={"same-c.txt", "same-d.txt"},
            deleted={"same-a.txt", "same-b.txt"},
        ),
    )
    await db.commit()
    new_rows = list((await db.scalars(select(File).where(
        File.user_id == user_a.id,
        File.storage_key.in_({
            f"{user_a.id}/个人文件/same-c.txt",
            f"{user_a.id}/个人文件/same-d.txt",
        }),
        File.deleted_at.is_(None),
    ))).all())
    old_rows = list((await db.scalars(select(File).where(File.id.in_(old_ids)))).all())

    assert result.moved == 0 and result.created == 2
    assert len(new_rows) == 2 and not (old_ids & {row.id for row in new_rows})
    assert all(row.deleted_at is not None for row in old_rows)


@pytest.mark.asyncio
async def test_same_journal_fingerprint_repairs_stale_file_metadata(
    db, user_a, monkeypatch, tmp_path,
):
    _, targeted, root, binding = await _prepare_targeted_personal_binding(
        db, user_a, monkeypatch, tmp_path,
    )
    row = (await db.scalars(select(File).where(
        File.user_id == user_a.id,
        File.storage_key.endswith("/个人文件/base.txt"),
    ))).one()
    last_full_reconcile = binding.last_reconciled_at
    row.size = "999"
    row.size_bytes = 999
    row.display_name = "错误元数据"
    row.ext = "bin"
    row.mime_type = "application/octet-stream"
    await db.flush()

    result = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"base.txt"}),
    )
    await db.flush()
    await db.refresh(row)

    assert result.updated == 1
    assert (row.size_bytes, row.size, row.display_name, row.ext) == (4, "4", "base", "txt")
    assert row.mime_type == "text/plain"
    assert binding.last_reconciled_at == last_full_reconcile


async def _prepare_project_container_binding(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.statcache as statcache
    import app.services.filesync.targeted as targeted

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(statcache, "get_settings", lambda: settings)
    monkeypatch.setattr(targeted, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id)
    project = Project(user_id=user_a.id, name="同步项目", start_date="2026-10-01")
    db.add(project)
    await db.flush()
    project_root = root / "项目文件" / "2026" / "10" / f"同步项目 #{project.id}"
    (project_root / "图表").mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        status="active", root_path=".", root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()
    return targeted, root, project, project_root, binding


@pytest.mark.asyncio
async def test_targeted_projection_ignores_project_container_directories(
    db, user_a, monkeypatch, tmp_path,
):
    """用户根 watcher 忽略项目年月/项目根容器，但仍登记项目内真实文件夹。"""
    targeted, root, project, _, binding = await _prepare_project_container_binding(
        db, user_a, monkeypatch, tmp_path,
    )

    summary = await targeted.project_path_events(
        db,
        user_a.id,
        binding,
        root,
        targeted.PathEventBatch(folders_created={
            "项目文件/2026",
            "项目文件/2026/10",
            f"项目文件/2026/10/同步项目 #{project.id}",
            f"项目文件/2026/10/同步项目 #{project.id}/图表",
        }),
    )
    await db.commit()

    folder = await db.scalar(select(Folder).where(
        Folder.user_id == user_a.id,
        Folder.project_id == project.id,
        Folder.name == "图表",
        Folder.deleted_at.is_(None),
    ))
    assert summary.rejected == 0
    assert dict(summary.rejection_reasons) == {}
    assert summary.folders_created == 1
    assert folder is not None


@pytest.mark.asyncio
async def test_user_root_folder_deletion_resolves_logical_personal_and_project_paths(
    db, user_a, monkeypatch, tmp_path,
):
    targeted, root, project, project_root, binding = await _prepare_project_container_binding(
        db, user_a, monkeypatch, tmp_path,
    )
    await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(folders_created={
            f"项目文件/2026/10/同步项目 #{project.id}/图表",
        }),
    )
    personal_path = root / "个人文件" / "资料"
    personal_path.mkdir(parents=True)
    await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(folders_created={"个人文件/资料"}),
    )
    await db.commit()
    project_folder = await db.scalar(select(Folder).where(
        Folder.user_id == user_a.id, Folder.project_id == project.id,
        Folder.name == "图表", Folder.deleted_at.is_(None),
    ))
    personal_folder = await db.scalar(select(Folder).where(
        Folder.user_id == user_a.id, Folder.project_id.is_(None),
        Folder.name == "资料", Folder.deleted_at.is_(None),
    ))
    assert project_folder is not None and personal_folder is not None

    (project_root / "图表").rmdir()
    personal_path.rmdir()
    result = await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(folders_deleted={
            f"项目文件/2026/10/同步项目 #{project.id}/图表",
            "个人文件/资料",
        }),
    )
    await db.commit()
    await db.refresh(project_folder)
    await db.refresh(personal_folder)

    assert result.folders_deleted == 2
    assert project_folder.deleted_at is not None and personal_folder.deleted_at is not None


@pytest.mark.asyncio
async def test_tool_create_file_advances_baseline_without_conflict(db, user_a, monkeypatch, tmp_path):
    """工具新建文件必须推进同步基线：同路径历史 journal（已删除旧版）不能让
    双向冲突检测把「工具单写两边」误判成两边都改过（咕咕天气产物误报案例）。"""
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.bindings as bindings
    import app.services.filesync.statcache as statcache
    from app.services.storage import LocalStorageBackend
    from app.services.storage.file_service import FileService

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    for mod in (reconcile, protocol, statcache, bindings):
        monkeypatch.setattr(mod, "get_settings", lambda: settings)

    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)

    # 第一版：直接落盘 + 对账，建立基线 journal；再删掉，留下 DELETE journal。
    (root / "doc.txt").write_text("old", encoding="utf-8")
    await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    (root / "doc.txt").unlink()
    await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()

    binding = (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_a.id,
        FileSyncBinding.workspace_id.is_(None),
    ))).one()

    # 工具新建同名文件：修复前 latest journal 是 DELETE（obs=None），
    # row.updated 更新且盘上指纹 != None → 误报冲突。
    svc = FileService(db)
    await svc.create_file(
        user_a.id, space="personal", project_id=None, folder_id=None, stage_name="",
        mind_map_id=None, display_name="doc", ext="txt", mime_type="text/plain",
        data=b"new-content",
    )
    await db.commit()

    conflict_ids = await bindings._pending_conflicts(db, user_a.id, binding, root)
    assert conflict_ids == ()
    journal = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.source == "file_api",
    ).order_by(FileSyncJournal.id.desc()))).first()
    assert journal is not None
    assert journal.observed_fingerprint == hashlib.sha256(b"new-content").hexdigest()


@pytest.mark.asyncio
async def test_pending_conflicts_skips_paths_covered_by_other_bindings(db, user_a, monkeypatch, tmp_path):
    """重叠绑定误报回归：整根绑定（root="."）不得用自己过期的基线，
    去判已被子绑定（root="个人文件"）正常推进的文件。"""
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.bindings as bindings
    import app.services.filesync.statcache as statcache

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    for mod in (reconcile, protocol, statcache, bindings):
        monkeypatch.setattr(mod, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "doc.txt").write_text("v1", encoding="utf-8")

    inner = await create_binding(
        db, user_id=user_a.id, source="local_directory",
        root_fingerprint="a"*64, root_path="个人文件",
    )
    outer = await create_binding(
        db, user_id=user_a.id, source="local_directory",
        root_fingerprint="b"*64, root_path=".",
    )
    await db.flush()

    # 子绑定正常推进：对账留下新基线；整根绑定只留一条过期基线（历史遗留形态）。
    await reconcile.reconcile_local_directory(db, user_a.id, binding=inner)
    await db.commit()
    await record_change(
        db, binding=outer, user_id=user_a.id, source="local_directory",
        operation="baseline", relative_path="个人文件/doc.txt",
        idempotency_key=build_idempotency_key(
            source="local_directory", operation="baseline",
            relative_path="个人文件/doc.txt", fingerprint="stale",
        ),
        observed_fingerprint="stale", status="synced",
    )
    await db.commit()

    # 咕咕更新文件（row + 盘上一起变），子绑定再次正常对账推进。
    (root / "doc.txt").write_text("v2-longer", encoding="utf-8")
    await reconcile.reconcile_local_directory(db, user_a.id, binding=inner)
    await db.commit()

    user_root = bindings._user_root(user_a.id)
    conflicts = await bindings._pending_conflicts(db, user_a.id, outer, user_root)
    assert conflicts == ()


@pytest.mark.asyncio
async def test_resolve_conflict_cancel_marks_resolved(db, user_a, monkeypatch, tmp_path):
    """「取消冲突」必须把冲突落成 resolved：只改 resolution 不改 status 会让
    冲突永远留在 pending 列表里，按钮看起来毫无反应。"""
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    from app.models import FileSyncConflict

    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(bindings, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))

    (tmp_path / str(user_a.id)).mkdir(parents=True)
    conflict = FileSyncConflict(
        binding_id=(await create_binding(
            db, user_id=user_a.id, source="local_directory",
            root_fingerprint="c"*64, root_path=".",
        )).id,
        user_id=user_a.id, relative_path="不存在的路径.txt",
        status="pending",
    )
    db.add(conflict)
    await db.flush()

    row = await bindings.resolve_sync_conflict(db, user_a.id, conflict.id, "cancel")
    await db.commit()
    await db.refresh(row)
    assert row.status == "resolved"
    assert row.resolution == "cancel"
    assert row.resolved_at is not None


@pytest.mark.parametrize("ledger_preexists", [True, False])
@pytest.mark.asyncio
async def test_resolve_missing_file_conflict_with_explicit_delete(
    db, user_a, monkeypatch, tmp_path, ledger_preexists,
):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    from app.models import FileSyncConflict, FileSyncJournal, StorageQuotaLedger
    from app.services.storage.quota_ledger import FILE_LIBRARY

    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    settings = SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
        quota=SimpleNamespace(default_storage_limit_bytes=100),
        sandbox=SimpleNamespace(persistent_quota_bytes=100, ephemeral_quota_bytes=0),
    )
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr("app.services.storage.quota_ledger.get_settings", lambda: settings)

    user_root = tmp_path / str(user_a.id)
    user_root.mkdir(parents=True)
    binding = await create_binding(
        db, user_id=user_a.id, source="local_directory", root_fingerprint="d" * 64,
        root_path=".",
    )
    file = File(
        user_id=user_a.id, display_name="missing", ext="txt",
        storage_key=f"{user_a.id}/missing.txt", size_bytes=12,
    )
    db.add(file)
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path="missing.txt",
        status="pending", remote_fingerprint="a" * 64,
    )
    db.add(conflict)
    if ledger_preexists:
        quota = StorageQuotaLedger(
            user_id=user_a.id, category=FILE_LIBRARY, limit_bytes=100, used_bytes=12,
            reserved_bytes=0, status="active",
        )
        db.add(quota)
    await db.flush()

    resolved = await bindings.resolve_sync_conflict(
        db, user_a.id, conflict.id, "confirm_delete",
    )
    await db.commit()
    await db.refresh(file)
    quota = await db.scalar(select(StorageQuotaLedger).where(
        StorageQuotaLedger.user_id == user_a.id,
        StorageQuotaLedger.category == FILE_LIBRARY,
    ))
    assert quota is not None
    await db.refresh(quota)
    journal = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.relative_path == "missing.txt",
    ))).one()

    assert resolved.status == "resolved" and resolved.resolution == "confirm_delete"
    assert file.deleted_at is not None
    assert quota.used_bytes == 0
    assert journal.operation == "delete" and journal.status == "synced"


@pytest.mark.asyncio
async def test_confirm_delete_refuses_if_missing_path_has_reappeared(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings

    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(bindings, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
    ))
    user_root = tmp_path / str(user_a.id)
    user_root.mkdir(parents=True)
    binding = await create_binding(
        db, user_id=user_a.id, source="local_directory", root_fingerprint="e" * 64,
        root_path=".",
    )
    (user_root / "missing.txt").write_text("back", encoding="utf-8")
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path="missing.txt",
        status="pending",
    )
    db.add(conflict)
    await db.flush()

    with pytest.raises(ValueError, match="本地路径已存在"):
        await bindings.resolve_sync_conflict(db, user_a.id, conflict.id, "confirm_delete")


@pytest.mark.asyncio
async def test_watcher_does_not_scan_on_startup_and_keeps_manual_gap_visible(db, user_a, user_b, monkeypatch, tmp_path):
    """启动只注册监听；监听 ready 不会导入历史文件或清除待人工核对标记。"""
    import asyncio
    from datetime import timedelta

    from app.core.tz import now_utc

    import app.services.filesync.bindings as bindings_service
    import app.services.filesync.protocol as protocol
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.targeted as targeted
    import app.services.filesync.watcher as watcher

    for module in (reconcile, protocol, targeted, watcher):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    for module in (reconcile, targeted, watcher):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(
            enabled=True, active_window_days=7, watch_hard_limit=1_024_000,
        ),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    for module in (reconcile, targeted, watcher, bindings_service):
        monkeypatch.setattr(module, "get_settings", lambda: settings)

    roots = {}
    probes = {user_a: "late-a", user_b: "late-b"}
    for user, probe in probes.items():
        root = tmp_path / str(user.id) / "个人文件"
        root.mkdir(parents=True)
        (root / "seed.txt").write_text("seed", encoding="utf-8")
        await reconcile.reconcile_local_directory(db, user.id)
        # 监听启动前出现的文件必须留给显式核对任务。
        (root / f"{probe}.txt").write_text(probe, encoding="utf-8")
        roots[user.id] = root
    user_a.is_active = True
    user_a.last_active_at = now_utc()
    user_b.is_active = True
    user_b.last_active_at = now_utc() - timedelta(days=30)
    await db.commit()

    bindings = {b.user_id: b for b in (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.source == protocol.FileSyncSource.LOCAL_DIRECTORY,
    ))).all()}
    for binding in bindings.values():
        binding.needs_reconcile = False
    await db.commit()
    active_gap_revision = bindings[user_a.id].gap_revision
    inactive_gap_revision = bindings[user_b.id].gap_revision

    class FakeSidecar:
        def __init__(self):
            self.watched = {}
            self.events = asyncio.Queue()
            self.registration_started = asyncio.Event()
            self.release_registration = asyncio.Event()

        async def start(self):
            return None

        async def watch(self, binding_id, root, *, included_root_entries=None):
            self.watched[binding_id] = root
            self.registration_started.set()
            await self.release_registration.wait()
            await self.events.put({"event": "ready", "binding_id": binding_id})

        async def unwatch(self, binding_id):
            self.watched.pop(binding_id, None)

        async def next_event(self):
            try:
                return self.events.get_nowait()
            except asyncio.QueueEmpty:
                return None

        async def close(self):
            return None

    sidecar = FakeSidecar()
    manager = watcher.FileSyncWatcherManager(
        refresh_interval=0.05, sidecar=sidecar,
    )
    stop_event = asyncio.Event()
    task = asyncio.create_task(manager.run(stop_event))
    try:
        await asyncio.wait_for(sidecar.registration_started.wait(), timeout=2.0)
        live_path = roots[user_a.id] / "during-registration.txt"
        live_path.write_text("及时投影", encoding="utf-8")
        await sidecar.events.put({
            "event": "change", "binding_id": bindings[user_a.id].id,
            "operation": "create", "object_type": "file",
            "relative_path": live_path.relative_to(sidecar.watched[bindings[user_a.id].id]).as_posix(),
        })
        for _ in range(100):
            projected = await db.scalar(select(File.id).where(
                File.user_id == user_a.id,
                File.display_name == "during-registration",
                File.deleted_at.is_(None),
            ))
            if projected is not None:
                break
            await asyncio.sleep(0.01)
        assert projected is not None, "watch() 未返回且尚未 ready 时，实时事件仍须完成 targeted 投影"
        assert bindings[user_a.id].id not in manager._ready_bindings
    finally:
        sidecar.release_registration.set()
        # 回归测试全量串行运行时，数据库状态更新可能被其他后台 I/O 延后；
        # 注册已释放后仍保留有限等待，最终仍必须观察到持久化 ready。
        for _ in range(500):
            await db.refresh(bindings[user_a.id])
            if bindings[user_a.id].watcher_status == "ready":
                break
            await asyncio.sleep(0.01)
        stop_event.set()
        await asyncio.wait_for(task, timeout=5.0)

    # 只有活跃用户占监听；不活跃绑定不占 inotify 资源
    assert set(sidecar.watched) == {bindings[user_a.id].id}
    for user, probe in probes.items():
        row = await db.scalar(select(File).where(
            File.user_id == user.id, File.display_name == probe,
            File.deleted_at.is_(None),
        ))
        assert row is None
    active_binding = bindings[user_a.id]
    inactive_binding = bindings[user_b.id]
    await db.refresh(active_binding)
    await db.refresh(inactive_binding)
    # 普通监听器重启不计为缺口；停机期间的变化由每周完整扫描覆盖。
    assert active_binding.needs_reconcile is False
    assert active_binding.gap_revision == active_gap_revision
    assert inactive_binding.needs_reconcile is False
    assert inactive_binding.gap_revision == inactive_gap_revision
    assert inactive_binding.watcher_status == "inactive"
    assert bindings[user_a.id].watcher_status == "ready"


@pytest.mark.asyncio
async def test_watcher_projection_retries_only_path_and_marks_manual_gap(db, user_a, monkeypatch, tmp_path):
    """单路径失败只重试该路径；耗尽后提示手动核对，不退化为整树扫描。"""
    import app.services.filesync.watcher as watcher

    root = tmp_path / "watch-root"
    root.mkdir()
    (root / "unrelated.txt").write_text("do not discover", encoding="utf-8")
    binding = await create_binding(
        db, user_id=user_a.id, source="local_directory",
        root_fingerprint="a" * 64, root_path=".",
    )
    await db.commit()

    calls = 0

    async def failed_projection(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise OSError("synthetic targeted failure")

    monkeypatch.setattr(watcher, "project_path_events", failed_projection)
    manager = watcher.FileSyncWatcherManager(sidecar=SimpleNamespace())
    manager._binding_roots[binding.id] = (user_a.id, root, "bidirectional")
    manager._queue_path_event({
        "binding_id": binding.id,
        "relative_path": "target.txt",
        "operation": "create",
        "object_type": "file",
    })

    for _ in range(manager.MAX_PATH_RETRIES):
        await manager._project_pending()

    assert calls == manager.MAX_PATH_RETRIES
    assert manager._path_events == {}
    unrelated = await db.scalar(select(File.id).where(
        File.user_id == user_a.id,
        File.display_name == "unrelated",
        File.deleted_at.is_(None),
    ))
    assert unrelated is None, "单路径失败不得触发整树扫描并导入无关文件"
    await db.refresh(binding)
    assert binding.needs_reconcile is True
    assert binding.watcher_status == "degraded"
    assert binding.health_error_code == "path_projection_failed"


@pytest.mark.asyncio
async def test_targeted_batch_quota_headroom_accumulates_across_creates(db, user_a, monkeypatch, tmp_path):
    """同批多个新建文件共享同一份配额余量：逐个扣减，不允许批量突破存储配额。"""
    import app.services.filesync.protocol as protocol
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.targeted as targeted

    for module in (reconcile, protocol, targeted):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    for module in (reconcile, targeted):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(targeted, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "seed.txt").write_text("seed", encoding="utf-8")
    await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()

    # 活量 4 字节，上限 100 → 批次起始余量 96
    user_a.storage_limit_bytes = 100
    await db.commit()

    (root / "a.bin").write_bytes(b"x" * 60)
    (root / "b.bin").write_bytes(b"y" * 60)
    binding = (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_a.id,
    ))).one()

    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"a.bin", "b.bin"}),
    )
    await db.commit()

    # a(60) 放行并扣减余量；b(60) > 剩余 36 → 拒绝，不能各自拿同一份余量
    assert summary.created == 1
    assert summary.rejected == 1
    assert dict(summary.rejection_reasons) == {"quota_exceeded": 1}
    names = sorted((await db.scalars(select(File.display_name).where(
        File.user_id == user_a.id, File.deleted_at.is_(None),
    ))).all())
    assert names == ["a", "seed"]

    # 已有文件扩容也必须纳入配额，而不能只校验 CREATE。
    (root / "a.bin").write_bytes(b"z" * 101)
    update_summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"a.bin"}),
    )
    await db.commit()
    assert update_summary.updated == 0
    assert update_summary.rejected == 1
    assert dict(update_summary.rejection_reasons) == {"quota_exceeded": 1}
    row = (await db.scalars(select(File).where(
        File.user_id == user_a.id, File.display_name == "a", File.deleted_at.is_(None),
    ))).one()
    assert row.size_bytes == 60


@pytest.mark.asyncio
async def test_live_filesync_applies_quota_deltas_once(db, user_a, monkeypatch, tmp_path):
    """实时 filesync 对新建/扩容/删除按字节增量更新账本，重放不重复计量。"""
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    import app.services.storage.quota_ledger as quota_ledger

    monkeypatch.setattr(reconcile, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(reconcile, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
        quota=SimpleNamespace(default_storage_limit_bytes=5),
        sandbox=SimpleNamespace(persistent_quota_bytes=100, ephemeral_quota_bytes=0),
    )
    monkeypatch.setattr(reconcile, "get_settings", lambda: settings)
    monkeypatch.setattr(targeted, "get_settings", lambda: settings)
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    (root / "base.txt").write_text("base", encoding="utf-8")
    await reconcile.reconcile_local_directory(db, user_a.id)
    await db.commit()
    binding = (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_a.id,
    ))).one()
    user_a.storage_limit_bytes = 5

    (root / "new.txt").write_text("v1", encoding="utf-8")
    batch = targeted.PathEventBatch(changed={"new.txt"}, created_files={"new.txt"})
    options = targeted.PathProjectionOptions(record_quota_deltas=True)
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, batch, options=options,
    )
    await db.commit()
    ledger = (await db.scalars(select(StorageQuotaLedger).where(
        StorageQuotaLedger.user_id == user_a.id,
        StorageQuotaLedger.category == "file_library",
    ))).one()
    await db.refresh(ledger)
    assert summary.created == 1
    assert ledger.used_bytes == 6  # 已有物理变更即使超限也必须如实入账

    # 相同事件/指纹重放不会再次增加用量。
    await targeted.project_path_events(db, user_a.id, binding, root, batch, options=options)
    await db.commit()
    await db.refresh(ledger)
    assert ledger.used_bytes == 6

    (root / "new.txt").write_text("v2-long", encoding="utf-8")
    await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(changed={"new.txt"}), options=options,
    )
    await db.commit()
    await db.refresh(ledger)
    assert ledger.used_bytes == 11

    (root / "new.txt").unlink()
    await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(deleted={"new.txt"}), options=options,
    )
    await db.commit()
    await db.refresh(ledger)
    assert ledger.used_bytes == 4
