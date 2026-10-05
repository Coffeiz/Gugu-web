import io
import json
import zipfile
from uuid import uuid4

import pytest

from app.models import UserSkill, WorkspaceDirectory
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


@pytest.mark.asyncio
async def test_preflight_ignores_tombstoned_partial_index_keys_and_reuses_default_directory(db, user_a):
    """部分唯一索引只约束活动目录；默认目录同名时应按系统身份复用。"""
    db.add_all([
        WorkspaceDirectory(
            user_id=user_a.id, name="默认工作区", directory_name="default",
            is_default=True, is_system=True,
        ),
        WorkspaceDirectory(
            user_id=user_a.id, name="目标目录", directory_name="target-dir",
        ),
    ])
    await db.flush()

    records = [
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "test-old", "source_type": "workspace_directory",
         "fields": {"name": "test", "is_default": False, "is_system": False, "deleted_at": "2026-09-01T00:00:00Z"}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "test-newer-deleted", "source_type": "workspace_directory",
         "fields": {"name": "test", "is_default": False, "is_system": False, "deleted_at": "2026-09-02T00:00:00Z"}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "qq-deleted", "source_type": "workspace_directory",
         "fields": {"name": "QQ", "is_default": False, "is_system": False, "deleted_at": "2026-09-03T00:00:00Z"}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "qq-active", "source_type": "workspace_directory",
         "fields": {"name": "QQ", "is_default": False, "is_system": False, "deleted_at": None}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "default-source", "source_type": "workspace_directory",
         "fields": {"name": "默认工作区", "is_default": True, "is_system": True, "deleted_at": None}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "target-name", "source_type": "workspace_directory",
         "fields": {"name": "目标目录", "is_default": False, "is_system": False, "deleted_at": None}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "new-name-1", "source_type": "workspace_directory",
         "fields": {"name": "归档重复名", "is_default": False, "is_system": False, "deleted_at": None}, "relations": []},
        {"record_schema": "gugu.workspace_directory.v1", "portable_id": "new-name-2", "source_type": "workspace_directory",
         "fields": {"name": "归档重复名", "is_default": False, "is_system": False, "deleted_at": None}, "relations": []},
    ]
    data = ("\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n").encode()
    packed_data = io.BytesIO()
    with zipfile.ZipFile(packed_data, "w") as packed:
        packed.writestr("records/workspaces/directories.jsonl", data)
    manifest = PortableArchiveManifest(
        origin_id=uuid4(), export_id=uuid4(), created_at="2026-10-03T00:00:00+00:00",
        complete=False,
        categories={"workspaces": PortableCategory(included=True, records=len(records), bytes=len(data))},
        entries=[PortableArchiveEntry(
            path="records/workspaces/directories.jsonl", category="workspaces",
            size=len(data), sha256="0" * 64, records=len(records),
        )],
    )

    with zipfile.ZipFile(io.BytesIO(packed_data.getvalue()), "r") as packed:
        conflicts = await find_unique_conflicts(db, user_id=user_a.id, archive=packed, manifest=manifest)

    assert conflicts == [
        {"source_type": "workspace_directory", "portable_id": "target-name", "fields": ["name"], "kind": "target_conflict"},
        {"source_type": "workspace_directory", "portable_id": "new-name-2", "fields": ["name"], "kind": "archive_duplicate"},
    ]
