from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.services.data_portability.schema import (
    FORMAT_VERSION,
    PORTABLE_CATEGORIES,
    PortableArchiveManifest,
    PortableEntityRecord,
    validate_archive_path,
)


def _manifest(*, complete: bool = True, excluded: set[str] | None = None) -> dict:
    excluded = excluded or set()
    return {
        "format_version": FORMAT_VERSION,
        "origin_id": str(uuid4()),
        "export_id": str(uuid4()),
        "created_at": "2026-10-02T00:00:00Z",
        "complete": complete,
        "categories": {
            category: {
                "included": category not in excluded,
                "records": 0,
                "bytes": 0,
            }
            for category in PORTABLE_CATEGORIES
        },
        "entries": [],
    }


def test_complete_manifest_can_be_used_for_replacement() -> None:
    manifest = PortableArchiveManifest.model_validate(_manifest())

    manifest.require_replaceable()


def test_trimmed_or_missing_category_manifest_cannot_replace_account_data() -> None:
    trimmed = _manifest(excluded={"drafts"})
    missing = _manifest()
    missing["categories"].pop("drafts")

    with pytest.raises(ValueError, match="不能裁剪"):
        PortableArchiveManifest.model_validate(trimmed).require_replaceable()
    with pytest.raises(ValidationError, match="显式声明全部"):
        PortableArchiveManifest.model_validate(missing)


@pytest.mark.parametrize("path", ["/etc/passwd", "../escape", "records/../../escape", "records\\escape", "records//item.json"])
def test_archive_paths_reject_absolute_traversal_and_noncanonical_aliases(path: str) -> None:
    with pytest.raises(ValueError):
        validate_archive_path(path)


def test_manifest_rejects_duplicate_paths_even_when_content_differs() -> None:
    manifest = _manifest(complete=False)
    manifest["categories"] = {"projects": {"included": True, "records": 2, "bytes": 2}}
    entry = {
        "path": "records/projects.jsonl",
        "category": "projects",
        "size": 1,
        "sha256": "a" * 64,
        "records": 1,
    }
    manifest["entries"] = [entry, {**entry, "sha256": "b" * 64}]

    with pytest.raises(ValidationError, match="路径重复"):
        PortableArchiveManifest.model_validate(manifest)


def test_portable_records_keep_relations_in_stable_portable_ids() -> None:
    row = PortableEntityRecord.model_validate({
        "record_schema": "project.v1",
        "portable_id": "prj_01HZZ4J7A5",
        "source_type": "project",
        "fields": {"name": "合成项目"},
        "relations": [{
            "relation_type": "contains",
            "target_type": "file",
            "target_portable_id": "file_01HZZ4J7A6",
        }],
    })

    assert row.relations[0].target_portable_id == "file_01HZZ4J7A6"
