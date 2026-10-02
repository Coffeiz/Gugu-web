import hashlib
import tempfile
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException, Response

from app.api.v1 import data_portability as api
from app.models import DataExportJob
from app.services.data_portability.crypto_stream import EncryptedArchiveWriter


class _Storage:
    def __init__(self, artifact=None):
        self.deleted = []
        self.artifact = artifact

    async def delete(self, key):
        self.deleted.append(key)

    async def iter_chunks(self, key):
        yield self.artifact


@pytest.mark.asyncio
async def test_export_delete_removes_owned_artifact_and_job(db, user_a, monkeypatch):
    storage = _Storage()
    monkeypatch.setattr(api, "get_storage", lambda: storage)
    job = DataExportJob(
        user_id=user_a.id, status="ready", artifact_key="private/export.gupa",
    )
    db.add(job)
    await db.commit()

    await api.delete_export(job.id, user=user_a, db=db)

    assert storage.deleted == ["private/export.gupa"]
    assert await db.get(DataExportJob, job.id) is None


@pytest.mark.asyncio
async def test_export_delete_rejects_active_and_other_users_jobs(db, user_a, user_b, monkeypatch):
    storage = _Storage()
    monkeypatch.setattr(api, "get_storage", lambda: storage)
    active = DataExportJob(user_id=user_a.id, status="running", artifact_key="private/active.gupa")
    foreign = DataExportJob(user_id=user_b.id, status="ready", artifact_key="private/other.gupa")
    db.add_all([active, foreign])
    await db.commit()

    with pytest.raises(HTTPException) as active_error:
        await api.delete_export(active.id, user=user_a, db=db)
    with pytest.raises(HTTPException) as owner_error:
        await api.delete_export(foreign.id, user=user_a, db=db)

    assert active_error.value.status_code == 409
    assert owner_error.value.status_code == 404
    assert storage.deleted == []


def test_download_ticket_is_job_scoped_and_expires(monkeypatch):
    import app.core.config as config

    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(secret_key="unit-test-key"))
    user_id, job_id = uuid4(), uuid4()
    ticket = api._download_ticket(user_id, job_id, 2_000_000_000)

    assert api._verify_download_ticket(ticket, job_id) == user_id
    assert api._verify_download_ticket(ticket, uuid4()) is None
    assert api._verify_download_ticket(api._download_ticket(user_id, job_id, 1), job_id) is None
    assert api._verify_download_ticket(ticket + "x", job_id) is None


@pytest.mark.asyncio
async def test_browser_download_ticket_uses_short_http_only_path_cookie(db, user_a):
    from datetime import timedelta
    from app.core.tz import now_utc

    job = DataExportJob(
        user_id=user_a.id, status="ready", artifact_key="private/export.gupa",
        expires_at=now_utc() + timedelta(hours=1),
    )
    db.add(job)
    await db.commit()
    response = Response()
    request = SimpleNamespace(
        url=SimpleNamespace(path=f"/api/v1/data-portability/exports/{job.id}/download-ticket", scheme="https"),
        base_url="https://example.test/",
    )

    result = await api.create_browser_download_ticket(
        job.id, request, response, user=user_a, db=db,
    )

    assert result["url"].endswith(f"/exports/{job.id}/download/browser")
    header = response.headers["set-cookie"]
    assert "HttpOnly" in header and "Secure" in header
    assert f"Path=/api/v1/data-portability/exports/{job.id}/download/browser" in header


@pytest.mark.asyncio
async def test_export_download_streams_authenticated_range_from_encrypted_artifact(db, user_a, monkeypatch):
    import app.core.config as config
    from datetime import timedelta
    from app.core.tz import now_utc

    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(secret_key="unit-test-key"))
    context_data = b"large archive payload for range streaming"
    job = DataExportJob(
        user_id=user_a.id, status="ready", artifact_key="private/export.gupa",
        expires_at=now_utc() + timedelta(hours=1),
    )
    db.add(job)
    await db.commit()
    with tempfile.TemporaryFile(mode="w+b") as encrypted:
        writer = EncryptedArchiveWriter(encrypted, f"data-portability:{user_a.id.hex}:{job.id.hex}")
        writer.write(context_data)
        writer.finish()
        encrypted.seek(0)
        artifact = encrypted.read()
    job.artifact_size = len(artifact)
    job.artifact_sha256 = hashlib.sha256(artifact).hexdigest()
    await db.commit()
    monkeypatch.setattr(api, "get_storage", lambda: _Storage(artifact))
    request = SimpleNamespace(headers={"range": "bytes=-7"})

    response = await api._stream_export(job.id, user_a.id, request, db)
    content = b"".join([chunk async for chunk in response.body_iterator])

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes {len(context_data) - 7}-{len(context_data) - 1}/{len(context_data)}"
    assert content == context_data[-7:]
