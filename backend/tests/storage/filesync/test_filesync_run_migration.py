"""任务表迁移不应因历史重复路径而改写或阻断用户文件数据。"""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def _migration(filename: str, module_name: str):
    path = Path(__file__).parents[3] / f"alembic/versions/{filename}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _seed_duplicate_files(connection):
    connection.execute(text(
        "CREATE TABLE files (id INTEGER PRIMARY KEY, user_id CHAR(32), "
        "storage_key TEXT, deleted_at DATETIME)"
    ))
    connection.execute(text(
        "INSERT INTO files VALUES "
        "(1, 'synthetic-user', 'synthetic-user/personal/file.txt', NULL), "
        "(2, 'synthetic-user', 'synthetic-user/personal/file.txt', NULL)"
    ))


def test_task_migration_preserves_legacy_duplicate_active_file_records():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id CHAR(32) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE file_sync_bindings (id INTEGER PRIMARY KEY)"))
        _seed_duplicate_files(connection)
        connection.execute(text("INSERT INTO users VALUES ('synthetic-user')"))
        connection.execute(text("INSERT INTO file_sync_bindings VALUES (1)"))

        with Operations.context(MigrationContext.configure(connection)):
            _migration(
                "20261007000003_add_manual_filesync_runs.py",
                "filesync_reconcile_runs",
            ).upgrade()

        assert "file_sync_reconcile_runs" in inspect(connection).get_table_names()
        rows = connection.execute(text(
            "SELECT id, storage_key FROM files ORDER BY id"
        )).all()
        assert rows == [
            (1, "synthetic-user/personal/file.txt"),
            (2, "synthetic-user/personal/file.txt"),
        ]


def test_active_storage_key_migration_refuses_legacy_duplicates_without_mutating_rows():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        _seed_duplicate_files(connection)

        with Operations.context(MigrationContext.configure(connection)):
            with pytest.raises(RuntimeError, match="重复的活动文件存储路径"):
                _migration(
                    "20261009000001_unique_active_file_storage_key.py",
                    "unique_active_file_storage_key",
                ).upgrade()

        assert connection.execute(text("SELECT COUNT(*) FROM files")).scalar_one() == 2
        assert "uq_files_active_user_storage_key" not in {
            index["name"] for index in inspect(connection).get_indexes("files")
        }
