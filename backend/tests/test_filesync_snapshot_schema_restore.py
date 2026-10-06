"""恢复旧版文件同步 schema，并在新版任务事实非空时拒绝覆盖。"""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def _migration():
    path = (
        Path(__file__).parents[1]
        / "alembic/versions/20261007000004_restore_filesync_snapshot_schema.py"
    )
    spec = importlib.util.spec_from_file_location("filesync_snapshot_restore", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _current_schema_engine():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id CHAR(32) PRIMARY KEY)"))
        connection.execute(text(
            "CREATE TABLE file_sync_bindings ("
            "id INTEGER PRIMARY KEY, user_id CHAR(32), watcher_status VARCHAR(24) NOT NULL, "
            "needs_reconcile BOOLEAN NOT NULL, health_revision INTEGER NOT NULL, "
            "gap_revision INTEGER NOT NULL, health_error_code VARCHAR(64))"
        ))
        connection.execute(text(
            "CREATE TABLE file_sync_journal (id INTEGER PRIMARY KEY, binding_id INTEGER)"
        ))
    return engine


def test_restore_recreates_empty_snapshot_schema_and_preserves_watcher_health():
    engine = _current_schema_engine()
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE file_sync_reconcile_runs (id CHAR(32) PRIMARY KEY, action VARCHAR(24), status VARCHAR(24))"
        ))
        connection.execute(text(
            "INSERT INTO file_sync_bindings VALUES (1, NULL, 'degraded', 1, 4, 2, 'watcher_error')"
        ))

        with Operations.context(MigrationContext.configure(connection)):
            _migration().upgrade()

        tables = set(inspect(connection).get_table_names())
        assert {"file_sync_reconcile_runs", "file_sync_user_scan_states"} <= tables
        binding_columns = {column["name"] for column in inspect(connection).get_columns("file_sync_bindings")}
        assert {
            "scope_revision", "dirty_revision", "baseline_dirty_revision", "baseline_generation",
            "last_daily_reconciled_at", "last_integrity_verified_at", "next_reconcile_at",
            "consecutive_failures", "watcher_status", "needs_reconcile", "gap_revision",
        } <= binding_columns
        run_columns = {column["name"] for column in inspect(connection).get_columns("file_sync_reconcile_runs")}
        assert {"mode", "reason", "checkpoint_ref", "candidate_generation"} <= run_columns
        assert "action" not in run_columns
        binding = connection.execute(text(
            "SELECT watcher_status, needs_reconcile, health_revision, gap_revision, health_error_code, "
            "baseline_generation FROM file_sync_bindings WHERE id=1"
        )).one()
        assert binding == ("degraded", 1, 4, 2, "watcher_error", None)
        assert connection.scalar(text("SELECT count(*) FROM file_sync_reconcile_runs")) == 0
        assert "dirty_revision" in {
            column["name"] for column in inspect(connection).get_columns("file_sync_journal")
        }
    engine.dispose()


def test_restore_refuses_to_drop_nonempty_new_task_table_before_schema_changes():
    engine = _current_schema_engine()
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE file_sync_reconcile_runs (id CHAR(32) PRIMARY KEY, action VARCHAR(24), status VARCHAR(24))"
        ))
        connection.execute(text(
            "INSERT INTO file_sync_reconcile_runs VALUES ('synthetic-run', 'manual', 'completed')"
        ))

        with Operations.context(MigrationContext.configure(connection)):
            with pytest.raises(RuntimeError, match="仍有记录"):
                _migration().upgrade()

        run_columns = {column["name"] for column in inspect(connection).get_columns("file_sync_reconcile_runs")}
        assert "action" in run_columns
        assert "baseline_generation" not in {
            column["name"] for column in inspect(connection).get_columns("file_sync_bindings")
        }
        assert connection.scalar(text("SELECT count(*) FROM file_sync_reconcile_runs")) == 1
    engine.dispose()
