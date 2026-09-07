import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / "20260904000001_prevent_duplicate_event_reminders.py"
    spec = importlib.util.spec_from_file_location("event_reminder_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_event_reminder_migration_merges_duplicates_before_unique_index():
    migration = _load_migration()
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE scheduled_tasks ("
            "id INTEGER PRIMARY KEY, user_id VARCHAR(36), event_id INTEGER, "
            "cron VARCHAR(60), channels VARCHAR(40), created_at DATETIME)"
        ))
        connection.execute(text(
            "INSERT INTO scheduled_tasks(id,user_id,event_id,cron,channels) VALUES "
            "(1,'user-a',7,'30 9 * * *','web,chat'),"
            "(2,'user-a',7,'30 9 * * *','im,chat'),"
            "(3,'user-a',NULL,'30 9 * * *','web'),"
            "(4,'user-a',NULL,'30 9 * * *','im')"
        ))

        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        rows = connection.execute(text(
            "SELECT id, channels FROM scheduled_tasks WHERE event_id = 7 ORDER BY id"
        )).all()
        assert rows == [(1, "web,chat,im")]
        assert connection.execute(text(
            "SELECT COUNT(*) FROM scheduled_tasks WHERE event_id IS NULL"
        )).scalar_one() == 2
        indexes = connection.execute(text("PRAGMA index_list('scheduled_tasks')")).fetchall()
        assert any(row[1] == "uq_scheduled_tasks_event_fire" for row in indexes)
        with pytest.raises(IntegrityError):
            connection.execute(text(
                "INSERT INTO scheduled_tasks(id,user_id,event_id,cron,channels) "
                "VALUES (5,'user-a',7,'30 9 * * *','web')"
            ))
