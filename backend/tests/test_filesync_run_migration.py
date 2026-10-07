"""任务表迁移不应因历史重复路径而改写或阻断用户文件数据。"""

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def _migration():
    path = Path(__file__).parents[1] / "alembic/versions/20261007000003_add_manual_filesync_runs.py"
    spec = importlib.util.spec_from_file_location("filesync_reconcile_runs", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_task_migration_preserves_legacy_duplicate_active_file_records():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id CHAR(32) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE file_sync_bindings (id INTEGER PRIMARY KEY)"))
        connection.execute(text(
            "CREATE TABLE files (id INTEGER PRIMARY KEY, user_id CHAR(32), "
            "storage_key TEXT, deleted_at DATETIME)"
        ))
        connection.execute(text("INSERT INTO users VALUES ('synthetic-user')"))
        connection.execute(text("INSERT INTO file_sync_bindings VALUES (1)"))
        connection.execute(text(
            "INSERT INTO files VALUES "
            "(1, 'synthetic-user', 'synthetic-user/personal/file.txt', NULL), "
            "(2, 'synthetic-user', 'synthetic-user/personal/file.txt', NULL)"
        ))

        with Operations.context(MigrationContext.configure(connection)):
            _migration().upgrade()

        assert "file_sync_reconcile_runs" in inspect(connection).get_table_names()
        rows = connection.execute(text(
            "SELECT id, storage_key FROM files ORDER BY id"
        )).all()
        assert rows == [
            (1, "synthetic-user/personal/file.txt"),
            (2, "synthetic-user/personal/file.txt"),
        ]
