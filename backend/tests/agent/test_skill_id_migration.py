from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_skill_id_migration_orders_existing_skills_and_seeds_next_sequence():
    engine = sa.create_engine("sqlite://")
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic/versions/20261013000001_use_skill_ids.py"
    )
    spec = importlib.util.spec_from_file_location("skill_id_migration", migration_path)
    migration = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(migration)

    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE users (id TEXT PRIMARY KEY)")
        connection.exec_driver_sql("INSERT INTO users(id) VALUES ('owner-a'), ('owner-b')")
        connection.exec_driver_sql(
            "CREATE TABLE user_skills ("
            "id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, slug VARCHAR(80) NOT NULL, "
            "created_at TEXT NOT NULL, CONSTRAINT uq_user_skill_owner_slug UNIQUE(owner_id, slug))"
        )
        connection.exec_driver_sql(
            "INSERT INTO user_skills(id, owner_id, slug, created_at) VALUES "
            "(3, 'owner-a', 'later', '2026-02-02'), "
            "(2, 'owner-a', 'first', '2026-02-01'), "
            "(4, 'owner-b', 'other', '2026-02-01')"
        )
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        migrated = connection.exec_driver_sql(
            "SELECT owner_id, skill_id FROM user_skills ORDER BY owner_id, id"
        ).all()
        counters = dict(connection.exec_driver_sql(
            "SELECT id, next_skill_sequence FROM users"
        ).all())
        assert migrated == [("owner-a", "U1"), ("owner-a", "U2"), ("owner-b", "U1")]
        assert counters == {"owner-a": 3, "owner-b": 2}
        assert "slug" not in {column["name"] for column in sa.inspect(connection).get_columns("user_skills")}
        assert ("owner_id", "skill_id") in {
            tuple(item["column_names"])
            for item in sa.inspect(connection).get_unique_constraints("user_skills")
        }

    engine.dispose()
