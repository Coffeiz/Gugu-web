import importlib.util
import json
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / "20261004000002_remove_retired_run_script_skill_links.py"
    spec = importlib.util.spec_from_file_location("retired_tool_link_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_retired_tool_migration_cleans_skill_bindings_and_frozen_snapshots():
    migration = _load_migration()
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE user_skills (id INTEGER PRIMARY KEY, related_tools JSON)"
        ))
        connection.execute(text(
            "CREATE TABLE conversation_sessions (id INTEGER PRIMARY KEY, session_context JSON)"
        ))
        connection.execute(text(
            "INSERT INTO user_skills(id, related_tools) VALUES "
            "(1, :tools), (2, :only_retired), (3, :unchanged)"
        ), {
            "tools": json.dumps(["web_search", "run_script", "read_file"]),
            "only_retired": json.dumps(["run_script"]),
            "unchanged": json.dumps(["web_search"]),
        })
        connection.execute(text(
            "INSERT INTO conversation_sessions(id, session_context) VALUES "
            "(1, :context), (2, :unrelated)"
        ), {
            "context": json.dumps({
                "locale": "zh-CN",
                "user_skill_snapshot": [
                    {"name": "f1-data", "related_tools": ["run_script", "web_search"]},
                    {"name": "other-skill", "related_tools": ["read_file"]},
                ],
            }),
            "unrelated": json.dumps({"locale": "zh-CN"}),
        })

        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        skill_rows = connection.execute(text(
            "SELECT id, related_tools FROM user_skills ORDER BY id"
        )).all()
        assert skill_rows == [
            (1, json.dumps(["web_search", "read_file"])),
            (2, json.dumps([])),
            (3, json.dumps(["web_search"])),
        ]
        session_rows = connection.execute(text(
            "SELECT id, session_context FROM conversation_sessions ORDER BY id"
        )).all()
        assert json.loads(session_rows[0][1]) == {
            "locale": "zh-CN",
            "user_skill_snapshot": [
                {"name": "f1-data", "related_tools": ["web_search"]},
                {"name": "other-skill", "related_tools": ["read_file"]},
            ],
        }
        assert json.loads(session_rows[1][1]) == {"locale": "zh-CN"}
