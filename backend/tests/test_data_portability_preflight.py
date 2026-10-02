import hashlib
import io
import json
import zipfile
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import DataImportJob, UserSkill
from app.services.data_portability import crypto_stream
from app.services.data_portability.archive import ArchiveProducer, build_encrypted_archive
from app.services.data_portability.crypto_stream import EncryptedArchiveReader, EncryptedArchiveWriter
from app.services.data_portability.import_preflight import process_import_preflight
from app.services.data_portability.jobs import ClaimedJob
from app.services.storage import LocalStorageBackend


@pytest.mark.asyncio
async def test_preflight_retains_archive_stream_through_conflict_preview(db, user_a, tmp_path, monkeypatch):
    """The validated upload stream stays open until unique-conflict analysis finishes."""
    monkeypatch.setattr(
        crypto_stream, "get_settings",
        lambda: SimpleNamespace(secret_key="test-only-data-portability-key"),
    )
    db.add(UserSkill(
        owner_id=user_a.id, slug="preflight-collision", name="目标技能",
        description_short="测试", description_long="", category="custom",
        body="合成内容", related_tools=[], source="user", enabled=True,
        content_digest="b" * 64,
    ))
    await db.flush()

    record_bytes = (json.dumps({
        "record_schema": "gugu.skill.v1",
        "portable_id": "source-skill-1",
        "source_type": "skill",
        "fields": {"slug": "preflight-collision", "name": "来源技能"},
        "relations": [],
    }, ensure_ascii=False, separators=(",", ":")) + "\n").encode()

    async def write_record(stream):
        stream.write(record_bytes)
        return 1

    portable_archive = io.BytesIO()
    context = f"data-portability:{user_a.id.hex}:{uuid4().hex}"
    export_id = uuid4()
    await build_encrypted_archive(
        portable_archive, context=context, origin_id=uuid4(), export_id=export_id,
        producers=[ArchiveProducer("records/skills.jsonl", "skills", write_record)],
        complete=False, included_categories={"skills"},
    )
    plain_zip = EncryptedArchiveReader(io.BytesIO(portable_archive.getvalue()), context).read()
    job = DataImportJob(
        user_id=user_a.id, mode="preflight", status="running", stage="validating",
        lease_owner="worker-fixture", staging_key="staging/archive.gupi",
        archive_sha256=hashlib.sha256(plain_zip).hexdigest(),
    )
    db.add(job)
    await db.commit()

    staging_context = f"data-portability-staging:{user_a.id.hex}:{job.id.hex}"
    staged = io.BytesIO()
    envelope = EncryptedArchiveWriter(staged, staging_context)
    envelope.write(plain_zip)
    envelope.finish()
    storage = LocalStorageBackend(tmp_path)
    await storage.put_stream(job.staging_key, io.BytesIO(staged.getvalue()), len(staged.getvalue()), "application/octet-stream")
    monkeypatch.setattr("app.services.data_portability.import_preflight.get_storage", lambda: storage)
    session_factory = async_sessionmaker(db.bind, expire_on_commit=False)

    await process_import_preflight(
        ClaimedJob("import", job.id, user_a.id, "preflight", "validating"),
        worker_id="worker-fixture", session_factory=session_factory,
    )

    await db.refresh(job)
    assert job.status == "preview_ready"
    assert job.preview["conflicts"]["total"] == 1
    assert job.preview["conflicts"]["items"][0]["fields"] == ["slug"]
