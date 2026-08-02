from uuid6 import uuid7

import pytest

from app.api.v1.config import (
    PathMigrationItem,
    PathMigrationRequest,
    _parse_path_migration_key,
)


def test_parse_personal_path_keeps_nested_folder_parts():
    user_id = uuid7()
    parsed = _parse_path_migration_key(
        f"{user_id}/个人文件/资料/2026/说明.PDF"
    )

    assert parsed == {
        "user_id": str(user_id),
        "space": "personal",
        "project_id": None,
        "folder_parts": ["资料", "2026"],
        "display_name": "说明",
        "ext": "pdf",
    }


def test_parse_project_path_ignores_year_month_prefix():
    user_id = uuid7()
    parsed = _parse_path_migration_key(
        f"{user_id}/项目文件/2026/08/项目名 #42/附件/说明.md"
    )

    assert parsed["space"] == "project"
    assert parsed["project_id"] == 42
    assert parsed["folder_parts"] == ["附件"]
    assert parsed["display_name"] == "说明"
    assert parsed["ext"] == "md"


def test_path_migration_request_limits_batch_size():
    items = [PathMigrationItem(file_id=i, key=f"k{i}", expected_old_key=f"o{i}") for i in range(1001)]
    with pytest.raises(ValueError, match="最多处理 1000 项"):
        PathMigrationRequest(items=items)
