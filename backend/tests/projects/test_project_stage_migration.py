"""保护已有项目阶段升级后的语义与无法识别数据的原子失败。"""

import importlib.util
from pathlib import Path
import sys

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


_MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic"
    / "versions"
    / "20260930000001_normalize_project_stages.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("project_stage_migration", _MIGRATION_PATH)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = migration
    spec.loader.exec_module(migration)
    return migration


def test_project_stage_migration_canonicalizes_known_legacy_shapes_and_preserves_state():
    migration = _load_migration()
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, stages_json TEXT, current_stage TEXT)"
        ))
        connection.execute(text(
            "INSERT INTO projects(id, stages_json, current_stage) VALUES "
            "(1, :stages, '旧阶段二')"
        ), {
            "stages": (
                '[{"name":"旧阶段一","todos":["未完成",{"id":"t9",'
                '"text":"已完成","done":true,"autoCompleted":true}]},'
                '{"label":"旧阶段二","todos":[]}]'
            ),
        })

        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        row = connection.execute(text(
            "SELECT stages_json, current_stage FROM projects WHERE id = 1"
        )).one()
        assert row[1] == "s1"
        assert migration.json.loads(row[0]) == [
            {
                "key": "s0",
                "label": "旧阶段一",
                "todos": [
                    {"id": "t1", "text": "未完成", "done": False},
                    {
                        "id": "t9", "text": "已完成", "done": True,
                        "autoCompleted": True,
                    },
                ],
            },
            {"key": "s1", "label": "旧阶段二", "todos": []},
        ]


def test_project_stage_migration_repairs_missing_and_duplicate_ids():
    migration = _load_migration()
    encoded, current = migration.normalize_project_stage_data(
        '[{"key":"s0","label":"阶段一","todos":[{"text":"事项一"}]},'
        '{"key":"s0","label":"阶段二","todos":[{"id":"t1","text":"事项二"}]}]',
        "s0",
        17,
    )

    stages = migration.json.loads(encoded)
    assert [stage["key"] for stage in stages] == ["s0", "s1"]
    assert [stage["todos"][0]["id"] for stage in stages] == ["t2", "t1"]
    assert current == "s0"


def test_project_stage_migration_fails_without_dropping_unrecognized_data():
    migration = _load_migration()
    with pytest.raises(RuntimeError, match=r"projects\.id=23.*缺少文本"):
        migration.normalize_project_stage_data(
            '[{"label":"阶段","todos":[{"id":"t1","unexpected":"保留不了"}]}]',
            "s0",
            23,
        )


def test_project_stage_migration_is_transactional_when_any_row_is_invalid():
    migration = _load_migration()
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, stages_json TEXT, current_stage TEXT)"
        ))
        connection.execute(
            text(
                "INSERT INTO projects(id, stages_json, current_stage) VALUES "
                "(:id, :stages, :current_stage)"
            ),
            [
                {"id": 1, "stages": '["合法旧阶段"]', "current_stage": None},
                {
                    "id": 2,
                    "stages": '[{"label":"阶段","todos":[{"done":true}]}]',
                    "current_stage": "s0",
                },
            ],
        )

    with pytest.raises(RuntimeError):
        with engine.begin() as connection:
            context = MigrationContext.configure(connection)
            with Operations.context(context):
                migration.upgrade()

    with engine.connect() as connection:
        rows = connection.execute(text(
            "SELECT id, stages_json, current_stage FROM projects ORDER BY id"
        )).all()
        assert rows == [
            (1, '["合法旧阶段"]', None),
            (2, '[{"label":"阶段","todos":[{"done":true}]}]', "s0"),
        ]
