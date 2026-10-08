from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1.filesync_admin import BindingActionRequest, binding_reconcile, reconcile_issue_bindings
from app.models import FileSyncBinding, FileSyncConflict, FileSyncJournal, FileSyncOutbox, FileSyncReconcileRun
from app.services.filesync.admin import admin_resolve_conflict, get_admin_sync_status


def _local_settings(tmp_path):
    return SimpleNamespace(storage=SimpleNamespace(backend="local", local_path=str(tmp_path)))


@pytest.mark.asyncio
async def test_admin_status_aggregates_bindings_failures_conflicts_and_outbox(db, user_a, tmp_path, monkeypatch):
    import app.services.filesync.admin as admin

    monkeypatch.setattr(admin, "get_settings", lambda: _local_settings(tmp_path))
    monkeypatch.setattr(admin, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(admin, "is_file_sync_enabled", lambda: True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        root_path="个人文件", root_fingerprint="a" * 64, revision=3,
    )
    db.add(binding)
    await db.flush()
    db.add_all([
        FileSyncJournal(
            binding_id=binding.id, user_id=user_a.id, idempotency_key="a",
            source="local_directory", operation="update", relative_path="a.txt",
            status="synced", revision=1,
        ),
        FileSyncJournal(
            binding_id=binding.id, user_id=user_a.id, idempotency_key="b",
            source="local_directory", operation="create", relative_path="b.txt",
            status="rejected", error_code="path_outside_binding", revision=2,
        ),
        FileSyncConflict(
            binding_id=binding.id, user_id=user_a.id, relative_path="a.txt",
            source="local_directory", status="pending",
            baseline_fingerprint="b" * 64, local_fingerprint="c" * 64,
        ),
        FileSyncOutbox(
            user_id=user_a.id, event_id="evt-test", resource="files", operation="refresh",
            status="pending",
        ),
    ])
    await db.commit()

    result = await get_admin_sync_status(db, user_id=user_a.id)

    assert result["supported"] is True
    assert result["featureEnabled"] is True
    assert result["totals"] == {
        "bindings": 1, "journals": 2, "pendingJournals": 0,
        "failedJournals": 0, "rejectedJournals": 1, "pendingConflicts": 1,
        "pendingOutbox": 1,
    }
    assert result["bindings"][0]["rootPath"] == "个人文件"
    assert result["failures"][0]["errorCode"] == "path_outside_binding"
    assert result["conflicts"][0]["relativePath"] == "a.txt"
    assert "fingerprint" not in result["conflicts"][0]


@pytest.mark.asyncio
async def test_admin_status_hides_local_sync_records_in_oss_mode(db, user_a, tmp_path, monkeypatch):
    import app.services.filesync.admin as admin

    db.add(FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        root_path="个人文件", root_fingerprint="a" * 64,
    ))
    await db.commit()
    monkeypatch.setattr(admin, "get_settings", lambda: SimpleNamespace(
        storage=SimpleNamespace(backend="oss", local_path=str(tmp_path)),
    ))
    monkeypatch.setattr(admin, "workspace_shell_supported", lambda: False)
    monkeypatch.setattr(admin, "is_file_sync_enabled", lambda: True)

    result = await get_admin_sync_status(db, user_id=user_a.id)

    assert result["supported"] is False
    assert result["bindings"] == []
    assert result["conflicts"] == []
    assert result["ignoredBindingCount"] == 1


@pytest.mark.asyncio
async def test_admin_status_closes_conflicts_for_missing_local_and_file_objects(
    db, user_a, tmp_path, monkeypatch,
):
    import app.services.filesync.admin as admin
    import app.services.filesync.bindings as bindings

    settings = _local_settings(tmp_path)
    monkeypatch.setattr(admin, "get_settings", lambda: settings)
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(admin, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(admin, "is_file_sync_enabled", lambda: True)

    (tmp_path / str(user_a.id)).mkdir()
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        root_path=".", root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id,
        relative_path="个人文件/已经删除.txt", source="local_directory",
        status="pending", baseline_fingerprint="a" * 64,
        local_fingerprint="b" * 64, remote_fingerprint="c" * 64,
    )
    db.add(conflict)
    await db.commit()

    result = await admin.get_admin_sync_status(db, user_id=user_a.id)

    assert result["totals"]["pendingConflicts"] == 0
    assert result["conflicts"] == []
    await db.refresh(conflict)
    assert conflict.status == "resolved"
    assert conflict.resolution == "stale"


@pytest.mark.asyncio
async def test_admin_reconcile_requires_explicit_confirmation(db):
    with pytest.raises(HTTPException) as exc:
        await binding_reconcile(1, BindingActionRequest(confirm=False), db=db)
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException) as exc:
        await reconcile_issue_bindings(BindingActionRequest(confirm=False), db=db)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_admin_reconcile_issues_only_enqueues_anomalous_active_regular_local_bindings(
    db, user_a, user_b, tmp_path, monkeypatch,
):
    import app.core.config as config
    import app.api.v1.filesync_admin as filesync_admin
    import app.services.filesync.admin as filesync_admin_service

    monkeypatch.setattr(config, "get_settings", lambda: _local_settings(tmp_path))
    monkeypatch.setattr(filesync_admin, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(filesync_admin_service, "get_settings", lambda: _local_settings(tmp_path))
    monkeypatch.setattr(filesync_admin_service, "workspace_shell_supported", lambda: True)
    eligible_a = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        root_path=".", root_fingerprint="a" * 64,
    )
    busy_a = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        root_path="documents", root_fingerprint="b" * 64,
    )
    eligible_b = FileSyncBinding(
        user_id=user_b.id, source="local_directory", mode="bidirectional",
        root_path=".", root_fingerprint="c" * 64,
    )
    inactive = FileSyncBinding(
        user_id=user_b.id, source="local_directory", mode="bidirectional",
        status="inactive", root_path="archive", root_fingerprint="d" * 64,
    )
    mirror = FileSyncBinding(
        user_id=user_b.id, source="local_directory", mode="mirror_out",
        root_path="export", root_fingerprint="e" * 64,
    )
    healthy = FileSyncBinding(
        user_id=user_b.id, source="local_directory", mode="bidirectional",
        root_path="healthy", root_fingerprint="f" * 64,
        watcher_status="ready", needs_reconcile=False,
    )
    db.add_all([eligible_a, busy_a, eligible_b, inactive, mirror, healthy])
    await db.flush()
    queued = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=eligible_a.id, action="repair",
        allow_delete=False, status="queued", root_fingerprint=eligible_a.root_fingerprint,
    )
    running = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=busy_a.id, action="repair",
        allow_delete=False, status="running", root_fingerprint=busy_a.root_fingerprint,
    )
    db.add_all([queued, running])
    await db.commit()

    first = await reconcile_issue_bindings(BindingActionRequest(confirm=True), db=db)
    assert first == {
        "eligible": 3, "queued": 2, "busy": 1, "skipped": 0,
    }
    second = await reconcile_issue_bindings(BindingActionRequest(confirm=True), db=db)
    assert second == {
        "eligible": 3, "queued": 2, "busy": 1, "skipped": 0,
    }
    rows = list((await db.scalars(
        select(FileSyncReconcileRun).where(FileSyncReconcileRun.action == "repair")
    )).all())
    assert all(row.allow_delete is False for row in rows)
    assert {row.binding_id for row in rows} == {eligible_a.id, busy_a.id, eligible_b.id}
@pytest.mark.asyncio
async def test_admin_conflict_resolution_honors_feature_flag(db, user_a, monkeypatch):
    import app.services.filesync.admin as admin

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        root_path=".", root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()
    conflict = FileSyncConflict(
        binding_id=binding.id, user_id=user_a.id, relative_path="a.txt", status="pending",
    )
    db.add(conflict)
    await db.commit()
    monkeypatch.setattr(admin, "is_file_sync_enabled", lambda: False)

    with pytest.raises(ValueError, match="文件同步未开启"):
        await admin_resolve_conflict(db, conflict.id, "cancel")
