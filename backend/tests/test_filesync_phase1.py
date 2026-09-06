from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import ConversationSession, File, FileSyncBinding, FileSyncConflict, FileSyncJournal
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
