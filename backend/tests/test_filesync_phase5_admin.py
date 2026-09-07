from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.filesync_admin import BindingActionRequest, binding_reconcile
from app.models import FileSyncBinding, FileSyncConflict, FileSyncJournal, FileSyncOutbox
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
async def test_admin_reconcile_requires_explicit_confirmation(db):
    with pytest.raises(HTTPException) as exc:
        await binding_reconcile(1, BindingActionRequest(confirm=False), db=db)
    assert exc.value.status_code == 400


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
