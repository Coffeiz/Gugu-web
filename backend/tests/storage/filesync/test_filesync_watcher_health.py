"""监听健康状态迁移后保留历史缺口，并允许完整修复前持续提示。"""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text

from app.services.filesync.health import update_binding_health
from app.models import FileSyncBinding
from app.services.filesync.protocol import FileSyncSource


def _migration():
    path = Path(__file__).parents[3] / "alembic/versions/20261007000002_add_filesync_watcher_health.py"
    spec = importlib.util.spec_from_file_location("filesync_watcher_health", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_health_migration_marks_existing_bindings_for_manual_reconciliation():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE file_sync_bindings (id INTEGER PRIMARY KEY, status TEXT NOT NULL)"
        ))
        connection.execute(text("INSERT INTO file_sync_bindings VALUES (1, 'active')"))
        with Operations.context(MigrationContext.configure(connection)):
            _migration().upgrade()
        columns = {item["name"] for item in inspect(connection).get_columns("file_sync_bindings")}
        assert {
            "watcher_status", "needs_reconcile", "health_revision", "gap_revision", "health_error_code",
        } <= columns
        row = connection.execute(text(
            "SELECT watcher_status, needs_reconcile, gap_revision FROM file_sync_bindings WHERE id=1"
        )).one()
        assert row == ("unknown", 1, 0)


@pytest.mark.asyncio
async def test_watcher_ready_does_not_clear_gap_until_manual_repair(db, user_a):
    binding = FileSyncBinding(
        user_id=user_a.id,
        source=FileSyncSource.LOCAL_DIRECTORY,
        root_fingerprint="synthetic-root",
        needs_reconcile=True,
        gap_revision=3,
    )
    db.add(binding)
    await db.commit()

    await update_binding_health(db, binding.id, status="ready")
    await db.refresh(binding)
    assert binding.watcher_status == "ready"
    assert binding.needs_reconcile is True
    assert binding.gap_revision == 3

    await update_binding_health(
        db, binding.id, status="degraded", error_code="watcher_error", gap_detected=True,
    )
    await db.refresh(binding)
    assert binding.health_error_code == "watcher_error"
    assert binding.needs_reconcile is True
    assert binding.gap_revision == 4

    await update_binding_health(db, binding.id, status="ready")
    await db.refresh(binding)
    assert binding.watcher_status == "ready"
    assert binding.health_error_code is None
    assert binding.needs_reconcile is True
    assert binding.gap_revision == 4
