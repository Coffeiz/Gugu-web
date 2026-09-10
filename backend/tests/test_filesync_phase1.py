import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import (
    ConversationSession,
    File,
    FileSyncBinding,
    FileSyncConflict,
    FileSyncJournal,
    Project,
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


@pytest.mark.asyncio
async def test_phase1_protocol_is_disabled_by_default(db, user_a):
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
        sandbox=SimpleNamespace(enabled=True, code_execution_enabled=True),
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
async def test_local_reconcile_projects_directory_workspace_shell_files(db, user_a, monkeypatch, tmp_path):
    """directory 型工作区绑定根即工作区目录：shell 产物按 space=workspace 投影。

    真实故障：_classify_path/_parse_directory_path 只认个人/项目 canonical 前缀，
    workspace/、workspace-<id>/ 下的 shell 产物（如 _tools/）整树被拒，文件库
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

    ws_root = tmp_path / str(user_a.id) / "workspace-probe"
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

    def counting_fingerprint(path):
        calls["count"] += 1
        return real_fingerprint(path)

    monkeypatch.setattr(reconcile, "_fingerprint", counting_fingerprint)
    second = await reconcile.reconcile_local_directory(db, user_a.id, use_stat_cache=True)
    await db.commit()
    assert second.created == 0 and second.updated == 0
    assert calls["count"] == 0  # 快路径命中，未重新哈希

    forced = await reconcile.reconcile_local_directory(db, user_a.id, use_stat_cache=False)
    await db.commit()
    assert forced.created == 0 and forced.updated == 0
    assert calls["count"] >= 1  # 日级兜底强制全量哈希


@pytest.mark.asyncio
async def test_targeted_projection_handles_create_update_move_delete(db, user_a, monkeypatch, tmp_path):
    """sidecar 精确事件按路径单点投影：创建/更新/移动重挂/软删除/空目录。"""
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

    # 更新
    (root / "new.txt").write_text("v2-longer", encoding="utf-8")
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"new.txt"}),
    )
    await db.commit()
    assert summary.updated == 1
    updated = await db.get(File, original_id)
    await db.refresh(updated)
    assert updated.size_bytes == len("v2-longer")

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
    (root / "sub").rmdir()
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(folders_deleted={"sub"}),
    )
    await db.commit()
    assert summary.folders_deleted == 1


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
