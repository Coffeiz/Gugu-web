import asyncio
import tempfile
import zipfile
from types import SimpleNamespace
import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models import DataExportJob, Project
from app.db import session as db_session
from app.services.data_portability.archive_validation import validate_encrypted_archive
from app.services.data_portability.jobs import ClaimedJob
from app.services.data_portability.worker import process_export_job
from app.services.storage import LocalStorageBackend


@pytest.mark.asyncio
async def test_export_worker_produces_owner_scoped_archive_and_ready_job(db, user_a, user_b, tmp_path, monkeypatch):
    import app.services.data_portability.crypto_stream as crypto_stream
    import app.services.data_portability.memories as memories
    import app.services.data_portability.worker as worker
    import app.services.storage as storage_service

    snapshot_sessions = set()
    dirty_export_rows_during_snapshot = []
    heartbeat_calls = 0
    build_producers = worker.build_record_producers
    build_archive = worker.build_encrypted_archive

    async def track_snapshot_session(session, **kwargs):
        snapshot_sessions.add(id(session.sync_session))
        return await build_producers(session, **kwargs)

    async def allow_heartbeat_during_archive(*args, **kwargs):
        await asyncio.sleep(0.02)
        return await build_archive(*args, **kwargs)

    async def fake_renew_lease(*args, **kwargs):
        nonlocal heartbeat_calls
        heartbeat_calls += 1
        return True

    def record_snapshot_job_writes(session, *_args):
        if id(session) in snapshot_sessions:
            dirty_export_rows_during_snapshot.extend(
                row for row in session.dirty if isinstance(row, DataExportJob)
            )

    event.listen(Session, "before_flush", record_snapshot_job_writes)
    monkeypatch.setattr(worker, "build_record_producers", track_snapshot_session)
    monkeypatch.setattr(worker, "build_encrypted_archive", allow_heartbeat_during_archive)
    monkeypatch.setattr(worker, "renew_lease", fake_renew_lease)
    monkeypatch.setattr(worker, "_EXPORT_HEARTBEAT_INTERVAL_SECONDS", 0.001)

    monkeypatch.setattr(
        crypto_stream, "get_settings", lambda: SimpleNamespace(secret_key="test-portability-key"),
    )
    storage = LocalStorageBackend(tmp_path / "private-storage")
    monkeypatch.setattr(storage_service, "get_storage", lambda: storage)
    monkeypatch.setattr(worker, "get_storage", lambda: storage)
    monkeypatch.setattr(memories, "get_storage", lambda: storage)

    own = Project(user_id=user_a.id, name="本账号项目")
    foreign = Project(user_id=user_b.id, name="其他账号项目")
    export = DataExportJob(
        user_id=user_a.id, status="running", stage="exporting",
        options={"categories": ["account", "projects"]},
        lease_owner="worker-test",
    )
    db.add_all([own, foreign, export])
    await db.commit()

    try:
        await process_export_job(
            ClaimedJob("export", export.id, user_a.id, "export", "exporting"),
            worker_id="worker-test", session_factory=db_session._SessionLocal,
        )
    finally:
        event.remove(Session, "before_flush", record_snapshot_job_writes)

    await db.refresh(export)
    assert export.status == "ready"
    assert heartbeat_calls > 0
    assert dirty_export_rows_during_snapshot == []
    assert export.artifact_key and export.artifact_sha256
    encrypted = tempfile.TemporaryFile(mode="w+b")
    async for chunk in storage.iter_chunks(export.artifact_key):
        encrypted.write(chunk)
    encrypted.seek(0)
    context = f"data-portability:{user_a.id.hex}:{export.id.hex}"
    result = validate_encrypted_archive(encrypted, context=context)
    from app.services.data_portability.crypto_stream import EncryptedArchiveReader
    encrypted.seek(0)
    reader = EncryptedArchiveReader(encrypted, context)
    with zipfile.ZipFile(reader, "r") as archive:
        records = archive.read("records/projects.jsonl").decode("utf-8")
        account = archive.read("records/account.json").decode("utf-8")
    reader.close()
    encrypted.close()

    assert result.manifest.complete is False
    assert "本账号项目" in records
    assert "其他账号项目" not in records
    assert "alice@test.local" in account
    assert {name for name, category in result.manifest.categories.items() if category.included} == {
        "account", "projects", "archive_docs",
    }
