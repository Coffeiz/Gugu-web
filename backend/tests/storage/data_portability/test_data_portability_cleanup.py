from datetime import timedelta

import pytest

from app.db import session as db_session
from app.core.tz import now_utc
from app.models import DataExportJob, DataImportJob
from app.services.data_portability.api_jobs import begin_preflight_import
from app.services.data_portability.worker import cleanup_expired_portability_data
from app.services.storage import LocalStorageBackend


@pytest.mark.asyncio
async def test_expired_archive_cleanup_removes_private_bytes_and_expires_jobs(
    db, user_a, tmp_path, monkeypatch,
):
    import app.services.data_portability.worker as worker

    storage = LocalStorageBackend(tmp_path / "private-storage")
    monkeypatch.setattr(worker, "get_storage", lambda: storage)
    expired_at = now_utc() - timedelta(seconds=1)
    export = DataExportJob(
        user_id=user_a.id, status="ready", stage="ready",
        artifact_key="private/export.gupa", artifact_size=4,
        artifact_sha256="digest", expires_at=expired_at,
    )
    imported = DataImportJob(
        user_id=user_a.id, mode="replace", status="completed", stage="completed",
        staging_key="private/staging.gupi", rollback_key="private/rollback.gupa",
        expires_at=expired_at, rollback_expires_at=expired_at,
        preview={"result": {"created": 1}},
    )
    db.add_all([export, imported])
    await db.commit()
    await storage.put(export.artifact_key, b"zip!", "application/zip")
    await storage.put(imported.staging_key, b"stage", "application/octet-stream")
    await storage.put(imported.rollback_key, b"back", "application/octet-stream")

    await cleanup_expired_portability_data(session_factory=db_session._SessionLocal)

    await db.refresh(export)
    await db.refresh(imported)
    assert export.status == "expired"
    assert export.artifact_key is None
    assert imported.status == "expired"
    assert imported.staging_key is None
    assert imported.rollback_key is None
    assert imported.preview is None
    assert await storage.stat("private/export.gupa") is None
    assert await storage.stat("private/staging.gupi") is None
    assert await storage.stat("private/rollback.gupa") is None


@pytest.mark.asyncio
async def test_expired_uploading_preflight_is_terminalized_and_releases_user_job_lock(
    db, user_a, tmp_path, monkeypatch,
):
    import app.services.data_portability.worker as worker

    storage = LocalStorageBackend(tmp_path / "private-storage-uploading")
    monkeypatch.setattr(worker, "get_storage", lambda: storage)
    expired_at = now_utc() - timedelta(seconds=1)
    job = DataImportJob(
        user_id=user_a.id, mode="preflight", status="uploading", stage="uploading",
        import_token_hash="one-time-token-hash", expires_at=expired_at,
    )
    db.add(job)
    await db.commit()
    staging_key = f"{user_a.id.hex}/.data-portability/imports/{job.id.hex}.gupi"
    await storage.put(staging_key, b"partial encrypted upload", "application/octet-stream")
    original_delete = storage.delete

    async def storage_temporarily_unavailable(_key):
        raise OSError("temporary storage failure")

    monkeypatch.setattr(storage, "delete", storage_temporarily_unavailable)

    await cleanup_expired_portability_data(session_factory=db_session._SessionLocal)

    await db.refresh(job)
    assert job.status == job.stage == "expired"
    assert job.error_code == "upload_expired"
    assert job.import_token_hash is None
    assert job.finished_at is not None
    assert job.staging_key == staging_key
    assert await storage.stat(staging_key) is not None

    next_job = await begin_preflight_import(
        db, user_id=user_a.id, token_hash="new-token-hash",
        expires_at=now_utc() + timedelta(hours=1),
    )
    assert next_job.status == "uploading"
    assert next_job.id != job.id

    monkeypatch.setattr(storage, "delete", original_delete)
    await cleanup_expired_portability_data(session_factory=db_session._SessionLocal)
    await db.refresh(job)
    assert job.staging_key is None
    assert await storage.stat(staging_key) is None
