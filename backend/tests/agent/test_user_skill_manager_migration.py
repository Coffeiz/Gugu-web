import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


def test_existing_skills_remain_user_managed_after_migration():
    path = Path(__file__).parents[2] / "alembic" / "versions" / "20261009000002_add_user_skill_manager.py"
    spec = importlib.util.spec_from_file_location("user_skill_manager_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE user_skills (id INTEGER PRIMARY KEY, slug VARCHAR(80) NOT NULL)"
        ))
        connection.execute(text(
            "INSERT INTO user_skills(id, slug) VALUES (1, 'old-skill'), (2, 'another-skill')"
        ))
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        assert connection.execute(text(
            "SELECT managed_by FROM user_skills ORDER BY id"
        )).scalars().all() == ["user", "user"]

        with Operations.context(context):
            migration.downgrade()
        assert "managed_by" not in {row[1] for row in connection.execute(text("PRAGMA table_info(user_skills)"))}
