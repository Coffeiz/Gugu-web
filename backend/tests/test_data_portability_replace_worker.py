import json
import tempfile
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.db import session as db_session
from app.models import DataImportJob, Project, UserPreferences
from app.services.data_portability.archive import ArchiveProducer, build_encrypted_archive
from app.services.data_portability.archive_validation import validate_encrypted_archive
from app.services.data_portability.jobs import ClaimedJob
from app.services.data_portability.schema import PORTABLE_CATEGORIES
from app.services.data_portability.worker import process_replace_import
from app.services.storage import LocalStorageBackend


async def _source_archive(user_id, job_id, project_name, storage):
    async def write_project(stream):
        record = {
            "record_schema": "gugu.project.v1",
            "portable_id": str(uuid.uuid4()),
            "source_type": "project",
            "fields": {"name": project_name, "status": "active"},
            "relations": [],
        }
        stream.write((json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        return 1

    job_context = f"data-portability-staging:{user_id.hex}:{job_id.hex}"
    key = f"{user_id.hex}/.data-portability/imports/{job_id.hex}.gupi"
    with tempfile.TemporaryFile(mode="w+b") as archive:
        size, _digest, _manifest = await build_encrypted_archive(
            archive,
            context=job_context,
            origin_id=uuid.uuid4(),
            export_id=uuid.uuid4(),
            producers=[ArchiveProducer("records/projects.jsonl", "projects", write_project)],
            complete=True,
            included_categories=PORTABLE_CATEGORIES - {"archive_docs"},
        )
        archive.seek(0)
        encrypted = archive.read()
    validation_source = tempfile.TemporaryFile(mode="w+b")
    validation_source.write(encrypted)
    validation_source.seek(0)
    validation = validate_encrypted_archive(
        validation_source, context=job_context, allow_incomplete=False,
    )
    validation_source.close()
    await storage.put(key, encrypted, "application/octet-stream")
    return key, validation.archive_sha256


@pytest.mark.asyncio
async def test_replace_worker_switches_all_data_and_rollback_restores_snapshot(
    db, user_a, tmp_path, monkeypatch,
):
    import app.core.config as config
    import app.services.data_portability.crypto_stream as crypto_stream
    import app.services.data_portability.import_apply as import_apply
    import app.services.data_portability.memories as memories
    import app.services.data_portability.worker as worker
    import app.services.storage as storage_service
    from app.api.v1.data_portability import ImportRollback, rollback_import

    secret = "test-portability-key"
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(secret_key=secret))
    monkeypatch.setattr(crypto_stream, "get_settings", lambda: SimpleNamespace(secret_key=secret))
    storage = LocalStorageBackend(tmp_path / "private-storage")
    monkeypatch.setattr(storage_service, "get_storage", lambda: storage)
    monkeypatch.setattr(worker, "get_storage", lambda: storage)
    monkeypatch.setattr(memories, "get_storage", lambda: storage)
    monkeypatch.setattr(import_apply, "get_storage", lambda: storage)

    original = Project(user_id=user_a.id, name="替换前项目", status="active")
    original_preferences = UserPreferences(user_id=user_a.id, data_json='{"theme":"night"}')
    db.add(original)
    db.add(original_preferences)
    await db.commit()
    replace_job = DataImportJob(
        user_id=user_a.id, mode="replace", status="running", stage="queued",
        lease_owner="replace-worker",
    )
    db.add(replace_job)
    await db.commit()
    staging_key, digest = await _source_archive(user_a.id, replace_job.id, "归档项目", storage)
    replace_job.staging_key = staging_key
    replace_job.archive_sha256 = digest
    await db.commit()

    await process_replace_import(
        ClaimedJob("import", replace_job.id, user_a.id, "replace", "queued"),
        worker_id="replace-worker", session_factory=db_session._SessionLocal,
    )
    await db.refresh(replace_job)
    projects_after_replace = (await db.execute(select(Project.name).where(Project.user_id == user_a.id))).scalars().all()
    assert replace_job.status == "completed"
    assert projects_after_replace == ["归档项目"]
    preferences_after_replace = (await db.execute(
        select(UserPreferences.data_json).where(UserPreferences.user_id == user_a.id)
    )).scalar_one_or_none()
    assert preferences_after_replace is None
    assert replace_job.rollback_key and replace_job.rollback_expires_at
    rollback = await rollback_import(
        replace_job.id, ImportRollback(idempotency_key="rollback-worker-test-01"),
        user=user_a, db=db,
    )
    rollback_job = await db.get(DataImportJob, uuid.UUID(rollback["id"]))
    rollback_job.status = "running"
    rollback_job.lease_owner = "rollback-worker"
    await db.commit()

    await process_replace_import(
        ClaimedJob("import", rollback_job.id, user_a.id, "rollback", "queued"),
        worker_id="rollback-worker", session_factory=db_session._SessionLocal,
    )
    await db.refresh(replace_job)
    await db.refresh(rollback_job)
    restored = (await db.execute(select(Project.name).where(Project.user_id == user_a.id))).scalars().all()
    restored_preferences = (await db.execute(
        select(UserPreferences.data_json).where(UserPreferences.user_id == user_a.id)
    )).scalar_one()
    assert rollback_job.status == "rolled_back"
    assert replace_job.status == "rolled_back"
    assert restored == ["替换前项目"]
    assert restored_preferences == '{"theme":"night"}'
