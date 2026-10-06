"""清理快照重构结构不能删除原同步事实或其他功能数据。"""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def _migration():
    path = Path(__file__).parents[1] / "alembic/versions/20261007000001_retire_filesync_snapshot_schema.py"
    spec = importlib.util.spec_from_file_location("filesync_retirement", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("legacy", [False, True])
def test_cleanup_preserves_binding_journal_and_unrelated_data(legacy):
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE file_sync_bindings (id INTEGER PRIMARY KEY, revision INTEGER, root_path TEXT)"))
        connection.execute(text("CREATE TABLE file_sync_journal (id INTEGER PRIMARY KEY, binding_id INTEGER, revision INTEGER, relative_path TEXT)"))
        connection.execute(text("CREATE TABLE trash_purge_jobs (id INTEGER PRIMARY KEY, status TEXT)"))
        connection.execute(text("INSERT INTO file_sync_bindings VALUES (1, 9, '.')"))
        connection.execute(text("INSERT INTO file_sync_journal VALUES (2, 1, 9, 'sample.txt')"))
        connection.execute(text("INSERT INTO trash_purge_jobs VALUES (3, 'succeeded')"))
        if legacy:
            for table in ("file_sync_bindings", "file_sync_journal"):
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN dirty_revision INTEGER DEFAULT 0"))
            for name in (
                "scope_revision", "baseline_dirty_revision", "baseline_generation",
                "last_daily_reconciled_at", "last_integrity_verified_at",
                "next_reconcile_at", "consecutive_failures",
            ):
                connection.execute(text(f"ALTER TABLE file_sync_bindings ADD COLUMN {name} TEXT"))
            connection.execute(text("CREATE INDEX journal_dirty ON file_sync_journal(binding_id, dirty_revision)"))
            connection.execute(text("CREATE TABLE file_sync_reconcile_runs (id INTEGER PRIMARY KEY, status TEXT)"))
            connection.execute(text("INSERT INTO file_sync_reconcile_runs VALUES (4, 'failed')"))
            connection.execute(text("CREATE TABLE file_sync_user_scan_states (user_id TEXT PRIMARY KEY)"))
        with Operations.context(MigrationContext.configure(connection)):
            _migration().upgrade()
            _migration().upgrade()
        assert connection.execute(text("SELECT * FROM file_sync_bindings")).all() == [(1, 9, '.')]
        assert connection.execute(text("SELECT * FROM file_sync_journal")).all() == [(2, 1, 9, 'sample.txt')]
        assert connection.execute(text("SELECT * FROM trash_purge_jobs")).all() == [(3, 'succeeded')]
        assert "file_sync_reconcile_runs" not in inspect(connection).get_table_names()
        assert "file_sync_user_scan_states" not in inspect(connection).get_table_names()


@pytest.mark.parametrize("status", ["queued", "running", "paused", "cancelling"])
def test_active_snapshot_task_rejects_cleanup_without_dropping_tables(status):
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE file_sync_reconcile_runs (id INTEGER PRIMARY KEY, status TEXT)"))
        connection.execute(text("INSERT INTO file_sync_reconcile_runs VALUES (1, :status)"), {"status": status})
        with Operations.context(MigrationContext.configure(connection)):
            with pytest.raises(RuntimeError, match="任务未结束"):
                _migration().upgrade()
        assert connection.scalar(text("SELECT count(*) FROM file_sync_reconcile_runs")) == 1
