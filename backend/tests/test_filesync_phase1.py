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
    Workspace,
)
from app.services.filesync import (
    FileSyncDisabled,
    build_idempotency_key,
    create_binding,
    normalize_relative_path,
    record_change,
    validate_sync_path,
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


def test_filesync_is_enabled_by_default():
    assert FileSyncSettings().enabled is True


async def _execute_persisted_filesync_job(run_id):
    import app.db.session as db_session
    import app.services.filesync.jobs as jobs

    async with db_session._SessionLocal() as worker_db:
        claim = await jobs.claim_due_job(worker_db)
    assert claim is not None and claim[0] == run_id
    await jobs._run_claimed(db_session._SessionLocal, *claim)
    async with db_session._SessionLocal() as verify_db:
        from app.models import FileSyncReconcileRun

        return await verify_db.get(FileSyncReconcileRun, run_id)


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


async def _migrated_workspace_case(db, user, monkeypatch, tmp_path):
    from app.models import Folder, WorkspaceDirectory
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.jobs as jobs
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.outbox as outbox
    import app.services.workspaces as workspaces
    from app.services.filesync.file_ops import root_fingerprint
    from scripts.migrations.migrate_workspace_layout import migrate

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        quota=SimpleNamespace(default_storage_limit_bytes=1024 * 1024),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(workspaces, "get_settings", lambda: settings)
    for module in (baseline, bindings, jobs, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)

    async def deliver(_db, _row):
        return True

    monkeypatch.setattr(outbox, "deliver_file_event", deliver)

    directory = WorkspaceDirectory(
        user_id=user.id, name="默认工作区", directory_name="workspace",
        is_default=True, is_system=True,
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user.id, name=directory.name, kind="directory",
        directory_id=directory.id, enabled=True,
    )
    folder = Folder(
        user_id=user.id, name="package", workspace_directory_id=directory.id,
    )
    db.add_all([workspace, folder])
    await db.flush()

    old_root = tmp_path / str(user.id) / "workspace"
    package = old_root / "package"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("# probe", encoding="utf-8")
    row = File(
        user_id=user.id, display_name="__init__", ext="py", space="workspace",
        workspace_directory_id=directory.id, folder_id=None,
        storage_key=f"{user.id}/workspace/package/__init__.py",
        size="7", size_bytes=7, storage_backend="local",
    )
    db.add(row)
    await db.commit()

    migration = await migrate(db, tmp_path, apply=True)
    assert migration["status"] == "completed"
    assert row.storage_key == f"{user.id}/workspace/default/package/__init__.py"
    assert row.folder_id is None

    root = await workspaces.resolve_workspace_root(db, user.id, workspace.id)
    assert root is not None
    binding = FileSyncBinding(
        user_id=user.id, workspace_id=workspace.id,
        source="local_directory", status="active", mode="mirror_in", root_path=".",
        root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    return workspace, folder, row, binding, migration


@pytest.mark.asyncio
async def test_migrated_known_workspace_file_is_reconciled_into_its_folder(
    db, user_a, monkeypatch, tmp_path,
):
    """布局迁移改路径后，持久整树任务仍修复既有文件的文件夹归属。"""
    from app.models import Folder

    import app.db.session as db_session
    import app.services.filesync.jobs as jobs

    workspace, folder, row, binding, migration = await _migrated_workspace_case(
        db, user_a, monkeypatch, tmp_path,
    )
    assert migration["status"] == "completed"
    assert row.storage_key == f"{user_a.id}/workspace/default/package/__init__.py"
    assert row.folder_id is None

    queued = await jobs.enqueue_reconcile(db, binding, mode="integrity_full", reason="manual")
    await db.commit()
    run = await _execute_persisted_filesync_job(queued.id)
    async with db_session._SessionLocal() as verify_db:
        migrated_file = await verify_db.get(File, row.id)
        migrated_folder = await verify_db.get(Folder, folder.id)
    assert run is not None and run.status == "succeeded", run.error_code if run else None
    assert migrated_file is not None
    assert migrated_folder is not None
    assert migrated_file.folder_id == migrated_folder.id

    version = migrated_file.version
    queued = await jobs.enqueue_reconcile(
        db, binding, mode="snapshot_diff", reason="manual",
    )
    await db.commit()
    run = await _execute_persisted_filesync_job(queued.id)
    assert run is not None and run.status == "succeeded"
    async with db_session._SessionLocal() as verify_db:
        migrated_file = await verify_db.get(File, row.id)
    assert migrated_file is not None
    assert migrated_file.version == version


@pytest.mark.asyncio
async def test_workspace_layout_migration_preserves_existing_file_for_reconciliation(
    db, user_a, monkeypatch, tmp_path,
):
    """工作区布局迁移保留文件记录及目录归属信息，供后续持久投影修复。"""
    workspace, folder, row, _binding, migration = await _migrated_workspace_case(
        db, user_a, monkeypatch, tmp_path,
    )

    assert migration["status"] == "completed"
    assert row.storage_key == f"{user_a.id}/workspace/default/package/__init__.py"
    assert row.deleted_at is None
    assert row.workspace_directory_id == workspace.directory_id == folder.workspace_directory_id
    assert row.folder_id is None


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
async def test_phase3_mirror_out_local_events_never_import_into_file_library(
    db, user_a, monkeypatch, tmp_path,
):
    """mirror_out 目录中的本地变更不能被 watcher 反向投影到文件库。"""
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    from app.services.filesync.targeted import PathEventBatch

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    root = tmp_path / str(user_a.id) / "export"
    root.mkdir(parents=True)
    (root / "local-only.txt").write_text("not imported", encoding="utf-8")
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_out",
        status="active", root_path="export", root_fingerprint="d" * 64,
    )
    db.add(binding)
    await db.flush()

    summary = await targeted.project_path_events(
        db, user_a.id, binding, root,
        PathEventBatch(changed={"local-only.txt"}),
    )

    assert summary.created == summary.updated == summary.deleted == 0
    assert (await db.scalars(select(File).where(File.user_id == user_a.id))).all() == []
    assert (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
    ))).all() == []


@pytest.mark.asyncio
async def test_phase3_watcher_does_not_watch_mirror_out_directory(
    db, user_a, monkeypatch, tmp_path,
):
    """mirror_out 目录不订阅本地事件，避免无效反向同步和活动误判。"""
    import app.services.filesync.watcher as watcher

    root = tmp_path / str(user_a.id) / "export"
    root.mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_out",
        status="active", root_path="export", root_fingerprint="e" * 64,
    )
    db.add(binding)
    await db.flush()

    class FakeSidecar:
        def __init__(self):
            self.watched = set()

        async def watch(self, binding_id, _root):
            self.watched.add(binding_id)

        async def unwatch(self, binding_id):
            self.watched.discard(binding_id)

    sidecar = FakeSidecar()
    manager = watcher.FileSyncWatcherManager(sidecar=sidecar)
    async def active_users(_db, _bindings):
        return {user_a.id}
    async def binding_root(_db, _binding):
        return root

    monkeypatch.setattr(manager, "_active_user_ids", active_users)
    monkeypatch.setattr(watcher, "_binding_root", binding_root)

    current, watched = await manager._refresh_sidecar_bindings(db, [binding], set())

    assert binding.id in current
    assert watched == set()
    assert sidecar.watched == set()


@pytest.mark.asyncio
async def test_phase3_bidirectional_changes_after_baseline_create_conflict(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.snapshots as snapshots

    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path)))
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(snapshots, "get_settings", lambda: settings)
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "conflict.txt"
    path.write_text("baseline", encoding="utf-8")
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件", root_fingerprint="test-root",
    )
    db.add(binding)
    await db.flush()
    snapshots.save_snapshot(user_a.id, binding.id, "conflict.txt", path)
    path.write_text("local change", encoding="utf-8")
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path="conflict.txt",
        baseline_fingerprint=hashlib.sha256(b"baseline").hexdigest(),
        local_fingerprint=hashlib.sha256(b"local change").hexdigest(),
        remote_fingerprint=hashlib.sha256(b"baseline").hexdigest(),
        source="local_directory", status="pending",
    )
    db.add(conflict)
    await db.commit()
    resolved = await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_local")
    await db.commit()
    assert resolved.status == "resolved"
    assert resolved.resolution == "keep_local"
    assert path.read_text(encoding="utf-8") == "local change"


@pytest.mark.asyncio
async def test_phase3_conflict_keep_remote_and_keep_both_apply_snapshot(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.bindings as bindings
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted

    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path)))
    for module in (bindings, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(bindings, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "conflict.txt"
    path.write_text("baseline", encoding="utf-8")
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件", root_fingerprint="test-root",
    )
    db.add(binding)
    await db.flush()
    snapshots.save_snapshot(user_a.id, binding.id, "conflict.txt", path)
    path.write_text("local change", encoding="utf-8")
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path="conflict.txt",
        baseline_fingerprint=hashlib.sha256(b"baseline").hexdigest(),
        local_fingerprint=hashlib.sha256(b"local change").hexdigest(),
        remote_fingerprint=hashlib.sha256(b"baseline").hexdigest(),
        source="local_directory", status="pending",
    )
    db.add(conflict)
    await db.commit()

    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_remote")
    await db.commit()
    assert path.read_text(encoding="utf-8") == "baseline"

    path.write_text("local second", encoding="utf-8")
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path="conflict.txt",
        baseline_fingerprint=hashlib.sha256(b"baseline").hexdigest(),
        local_fingerprint=hashlib.sha256(b"local second").hexdigest(),
        remote_fingerprint=hashlib.sha256(b"baseline").hexdigest(),
        source="local_directory", status="pending",
    )
    db.add(conflict)
    await db.commit()
    await resolve_sync_conflict(db, user_a.id, conflict.id, "keep_both")
    await db.commit()
    assert (root / "conflict (remote).txt").read_text(encoding="utf-8") == "baseline"
    remote_copy = await db.scalar(select(File).where(
        File.user_id == user_a.id,
        File.display_name == "conflict (remote)",
        File.deleted_at.is_(None),
    ))
    assert remote_copy is not None


@pytest.mark.asyncio
async def test_filesync_event_outbox_retries_and_preserves_event_id(db, user_a, monkeypatch):
    import app.services.filesync.outbox as outbox
    from app.core.tz import now_utc

    row = await enqueue_file_event(
        db, user_a.id, operation="refresh", entity_ids=(7,), source="local_directory",
    )
    await db.commit()
    published = []
    outcomes = iter((False, True))

    async def publish(*args, **kwargs):
        published.append((args, kwargs))
        return next(outcomes)

    monkeypatch.setattr(outbox.events, "publish", publish)
    assert await deliver_file_event(db, row) is False
    await db.commit()
    assert row.status == "pending"
    assert row.attempts == 1
    first_attempt = published[0][1]["event_id"]

    row.next_attempt_at = now_utc()
    await db.commit()
    assert await deliver_file_event(db, row) is True
    await db.commit()
    assert row.status == "delivered"
    assert row.attempts == 1
    assert [call[1]["event_id"] for call in published] == [first_attempt, first_attempt]
    assert all(call[1]["entity_ids"] == [7] for call in published)
    assert all(call[1]["source"] == "local_directory" for call in published)


@pytest.mark.asyncio
async def test_targeted_projection_handles_create_update_move_delete(db, user_a, monkeypatch, tmp_path):
    """sidecar 精确事件按路径单点投影：创建/更新/移动重挂/软删除/空目录。"""
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(targeted, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件", root_fingerprint="test-root",
    )
    db.add(binding)
    await db.commit()

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
async def test_folder_changed_after_scan_is_rejected_before_file_library_projection(
    db, user_a, monkeypatch, tmp_path,
):
    """目录候选在扫描后被替换/改动时，不创建目录记录或成功水位。"""
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    from app.services.filesync.scan import ScanEntry

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    ))

    user_root = tmp_path / str(user_a.id)
    root = user_root / "个人文件"
    directory = root / "stale-candidate"
    directory.mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件", root_fingerprint="test-root",
    )
    db.add(binding)
    await db.commit()

    info = directory.stat()
    stale = ScanEntry(
        relative_path="stale-candidate", object_type="folder", size_bytes=0,
        mtime_ns=info.st_mtime_ns - 1, ctime_ns=getattr(info, "st_ctime_ns", 0),
        fingerprint="stale-fingerprint",
    )
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root,
        targeted.PathEventBatch(folders_created={"stale-candidate"}),
        scanned_entries={"stale-candidate": stale},
    )
    await db.commit()

    assert summary.folders_created == 0
    assert summary.rejected == 1
    assert summary.rejected_paths == ("stale-candidate",)
    assert await db.scalar(select(Folder).where(
        Folder.user_id == user_a.id, Folder.name == "stale-candidate",
    )) is None
    assert await db.scalar(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.relative_path == "stale-candidate",
    )) is None


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


@pytest.mark.asyncio
async def test_watcher_tracks_only_active_users_and_leaves_scans_to_job_worker(db, user_a, user_b, monkeypatch, tmp_path):
    """Watcher 只持有活跃用户监听，不能在自己的循环中执行整树扫描。"""
    import asyncio
    from datetime import timedelta

    from app.core.tz import now_utc

    import app.services.filesync.bindings as binding_service
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    import app.services.filesync.watcher as watcher

    for module in (protocol, targeted, watcher):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    for module in (targeted, watcher):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(
            enabled=True, active_window_days=7, compensation_interval_seconds=86400,
        ),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    for module in (targeted, watcher, binding_service):
        monkeypatch.setattr(module, "get_settings", lambda: settings)

    roots = {}
    probes = {user_a: "late-a", user_b: "late-b"}
    for user, probe in probes.items():
        root = tmp_path / str(user.id) / "个人文件"
        root.mkdir(parents=True)
        (root / "seed.txt").write_text("seed", encoding="utf-8")
        binding = FileSyncBinding(
            user_id=user.id, source="local_directory", status="active",
            root_path="个人文件", root_fingerprint="test-root",
        )
        db.add(binding)
        # 监听启动前只存在于磁盘的新文件不能触发 watcher 内的整树投影。
        (root / f"{probe}.txt").write_text(probe, encoding="utf-8")
        roots[user.id] = root
    user_a.is_active = True
    user_a.last_active_at = now_utc()
    user_b.is_active = True
    user_b.last_active_at = now_utc() - timedelta(days=30)
    await db.commit()

    binding_by_user = {b.user_id: b for b in (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.source == protocol.FileSyncSource.LOCAL_DIRECTORY,
    ))).all()}

    class FakeSidecar:
        def __init__(self):
            self.watched = {}

        async def start(self):
            return None

        async def watch(self, binding_id, root):
            self.watched[binding_id] = root

        async def unwatch(self, binding_id):
            self.watched.pop(binding_id, None)

        async def next_event(self):
            return None

        async def close(self):
            return None

    sidecar = FakeSidecar()
    monkeypatch.setattr(watcher.asyncio, "get_running_loop", lambda: SimpleNamespace(time=lambda: 100.0))
    manager = watcher.FileSyncWatcherManager(
        refresh_interval=0.0, sidecar=sidecar,
    )
    stop_event = asyncio.Event()
    task = asyncio.create_task(manager.run(stop_event))
    try:
        await asyncio.sleep(1.2)
    finally:
        stop_event.set()
        await asyncio.wait_for(task, timeout=5.0)

    # 只有活跃用户占监听；不活跃绑定不占 inotify 资源
    assert set(sidecar.watched) == {binding_by_user[user_a.id].id}
    # watcher 只排队，不执行扫描；普通快照差异由独立任务调度器处理。
    for user, probe in probes.items():
        row = await db.scalar(select(File).where(
            File.user_id == user.id, File.display_name == probe,
            File.deleted_at.is_(None),
        ))
        assert row is None


@pytest.mark.asyncio
async def test_watcher_preserves_buffered_paths_after_targeted_rollback(
    db, user_a, monkeypatch, tmp_path,
):
    """数据库异常触发 rollback 后，本轮不再读取已过期的绑定 ORM 属性。

    防止精确事件分支读取 `binding.user_id` 触发 MissingGreenlet；失败事件
    应保留在精确路径缓冲区重试，而不是转为依赖基线的整树任务。
    """
    import asyncio

    from app.models import FileSyncReconcileRun
    import app.services.filesync.watcher as watcher

    monkeypatch.setattr(watcher, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(watcher, "workspace_shell_supported", lambda: True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path=".", root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    binding_id = binding.id

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path_batch = watcher.PathEventBatch(changed={"deferred.txt"})

    class SessionContext:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *_):
            return False

    class FakeSidecar:
        async def start(self):
            return None

        async def close(self):
            return None

    async def resolved(value):
        return value

    monkeypatch.setattr(watcher.db_session, "_SessionLocal", SessionContext)
    monkeypatch.setattr(watcher, "_refresh_bindings", lambda _db: resolved([binding]))

    async def refresh_sidecar_bindings(_manager, _db, _bindings, _pending):
        return {binding_id: (binding, root)}, {binding_id}

    async def fail_projection(*_args, **_kwargs):
        stop_event.set()
        raise RuntimeError("模拟数据库投影失败")

    monkeypatch.setattr(watcher.FileSyncWatcherManager, "_refresh_sidecar_bindings", refresh_sidecar_bindings)
    monkeypatch.setattr(watcher.FileSyncWatcherManager, "_drain_events", lambda *_: resolved(None))
    monkeypatch.setattr(watcher, "project_path_events", fail_projection)

    manager = watcher.FileSyncWatcherManager(refresh_interval=0, sidecar=FakeSidecar())
    manager._path_events[binding_id] = path_batch
    stop_event = asyncio.Event()
    await asyncio.wait_for(manager.run(stop_event), timeout=2)

    assert binding_id in manager._path_events
    assert manager._path_events[binding_id].changed == {"deferred.txt"}
    assert manager._path_event_retries[binding_id] == 1
    assert (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding_id,
    ))).all() == []


@pytest.mark.asyncio
async def test_targeted_batch_quota_headroom_accumulates_across_creates(db, user_a, monkeypatch, tmp_path):
    """同批多个新建文件共享同一份配额余量：逐个扣减，不允许批量突破存储配额。"""
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted

    for module in (protocol, targeted):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    for module in (targeted,):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )
    monkeypatch.setattr(targeted, "get_settings", lambda: settings)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    seed = File(
        user_id=user_a.id, display_name="seed", ext="txt", space="personal",
        storage_key=f"{user_a.id}/个人文件/seed.txt", storage_backend="local",
        size="4", size_bytes=4,
    )
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件", root_fingerprint="test-root",
    )
    db.add_all([seed, binding])
    await db.commit()

    # 活量 4 字节，上限 100 → 批次起始余量 96
    user_a.storage_limit_bytes = 100
    await db.commit()

    (root / "a.bin").write_bytes(b"x" * 60)
    (root / "b.bin").write_bytes(b"y" * 60)
    summary = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"a.bin", "b.bin"}),
    )
    await db.commit()

    # a(60) 放行并扣减余量；b(60) > 剩余 36 → 拒绝，不能各自拿同一份余量
    assert summary.created == 1
    assert summary.rejected == 1
    assert summary.rejected_paths == ("b.bin",)
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
    assert update_summary.rejected_paths == ("a.bin",)
    row = (await db.scalars(select(File).where(
        File.user_id == user_a.id, File.display_name == "a", File.deleted_at.is_(None),
    ))).one()
    assert row.size_bytes == 60
