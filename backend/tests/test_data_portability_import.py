import io
import json
import zipfile
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models import DataPortableIdentity, Project
from app.services.data_portability.import_apply import apply_incremental_archive
from app.services.data_portability.schema import PortableArchiveManifest, PortableArchiveEntry, PortableCategory


@pytest.mark.asyncio
async def test_incremental_import_adds_once_and_never_overwrites_target_project(db, user_a):
    """同一来源对象重放只跳过；目标已有对象不因导入被改写。"""
    existing = Project(user_id=user_a.id, name="目标端项目")
    db.add(existing)
    await db.flush()

    origin_id = uuid4()
    payload = {
        "record_schema": "gugu.project.v1",
        "portable_id": "source-project-1",
        "source_type": "project",
        "fields": {"name": "来源项目", "status": "active", "stages": []},
        "relations": [],
    }
    line = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("records/projects.jsonl", line)
    archive_data = output.getvalue()
    manifest = PortableArchiveManifest(
        origin_id=origin_id,
        export_id=uuid4(),
        created_at="2026-10-02T00:00:00+00:00",
        complete=False,
        categories={
            "projects": PortableCategory(included=True, records=1, bytes=len(line)),
        },
        entries=[PortableArchiveEntry(
            path="records/projects.jsonl", category="projects", size=len(line),
            sha256="0" * 64, records=1,
        )],
    )

    with zipfile.ZipFile(io.BytesIO(archive_data), "r") as packed:
        first = await apply_incremental_archive(
            db, user=user_a, archive=packed, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )
    await db.commit()
    with zipfile.ZipFile(io.BytesIO(archive_data), "r") as packed:
        repeated = await apply_incremental_archive(
            db, user=user_a, archive=packed, manifest=manifest,
            job_id=uuid4(), written_storage_keys=[],
        )

    projects = (await db.execute(select(Project).where(Project.user_id == user_a.id))).scalars().all()
    identity = (await db.execute(select(DataPortableIdentity).where(
        DataPortableIdentity.user_id == user_a.id,
        DataPortableIdentity.origin_id == origin_id,
    ))).scalar_one()
    assert first == {"created": 1, "skipped": 0, "memory_created": 0, "memory_skipped": 0}
    assert repeated == {"created": 0, "skipped": 1, "memory_created": 0, "memory_skipped": 0}
    assert {project.name for project in projects} == {"目标端项目", "来源项目"}
    assert identity.target_id != str(existing.id)
