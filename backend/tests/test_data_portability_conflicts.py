import io
import json
import zipfile
from uuid import uuid4

import pytest

from app.models import UserSkill
from app.services.data_portability.conflicts import find_unique_conflicts
from app.services.data_portability.schema import PortableArchiveEntry, PortableArchiveManifest, PortableCategory


@pytest.mark.asyncio
async def test_preflight_reports_direct_owner_unique_collision_without_exposing_values(db, user_a):
    db.add(UserSkill(
        owner_id=user_a.id,
        slug="fixture-skill",
        name="目标技能",
        description_short="测试",
        description_long="",
        category="custom",
        body="合成内容",
        related_tools=[],
        source="user",
        enabled=True,
        content_digest="a" * 64,
    ))
    await db.flush()
    origin_id = uuid4()
    record = {
        "record_schema": "gugu.skill.v1",
        "portable_id": "source-skill-1",
        "source_type": "skill",
        "fields": {"slug": "fixture-skill", "name": "来源技能"},
        "relations": [],
    }
    data = (json.dumps(record) + "\n").encode()
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as packed:
        packed.writestr("records/skills.jsonl", data)
    manifest = PortableArchiveManifest(
        origin_id=origin_id,
        export_id=uuid4(),
        created_at="2026-10-03T00:00:00+00:00",
        complete=False,
        categories={"skills": PortableCategory(included=True, records=1, bytes=len(data))},
        entries=[PortableArchiveEntry(
            path="records/skills.jsonl", category="skills", size=len(data),
            sha256="0" * 64, records=1,
        )],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as packed:
        conflicts = await find_unique_conflicts(db, user_id=user_a.id, archive=packed, manifest=manifest)

    assert conflicts == [{
        "source_type": "skill",
        "portable_id": "source-skill-1",
        "fields": ["slug"],
        "kind": "target_conflict",
    }]
    assert "fixture-skill" not in json.dumps(conflicts)
