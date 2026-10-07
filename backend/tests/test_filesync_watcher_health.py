"""监听健康状态迁移后保留历史缺口，并允许完整修复前持续提示。"""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text

from app.services.filesync.health import update_binding_health
from app.services.filesync.health import clear_reconcile_gap_if_current
from app.models import FileSyncBinding
from app.services.filesync.protocol import FileSyncSource


def _migration(filename, module_name):
    path = Path(__file__).parents[1] / "alembic/versions" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_health_migrations_mark_bindings_and_watermark_existing_runs():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE file_sync_bindings (id INTEGER PRIMARY KEY, status TEXT NOT NULL)"
        ))
        connection.execute(text("INSERT INTO file_sync_bindings VALUES (1, 'active')"))
        connection.execute(text(
            "CREATE TABLE file_sync_reconcile_runs (id INTEGER PRIMARY KEY)"
        ))
        connection.execute(text("INSERT INTO file_sync_reconcile_runs VALUES (1)"))
        with Operations.context(MigrationContext.configure(connection)):
            _migration(
                "20261007000002_add_filesync_watcher_health.py", "filesync_watcher_health",
            ).upgrade()
            _migration(
                "20261007000005_add_filesync_run_gap_watermark.py", "filesync_run_gap_watermark",
            ).upgrade()
        columns = {item["name"] for item in inspect(connection).get_columns("file_sync_bindings")}
        assert {
            "watcher_status", "needs_reconcile", "health_revision", "gap_revision", "health_error_code",
        } <= columns
        row = connection.execute(text(
            "SELECT watcher_status, needs_reconcile, gap_revision FROM file_sync_bindings WHERE id=1"
        )).one()
        assert row == ("unknown", 1, 0)
        run_columns = {item["name"] for item in inspect(connection).get_columns(
            "file_sync_reconcile_runs",
        )}
        assert "gap_revision_at_start" in run_columns
        assert connection.execute(text(
            "SELECT gap_revision_at_start FROM file_sync_reconcile_runs WHERE id=1"
        )).scalar_one() == 0


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


@pytest.mark.parametrize(
    ("overrides", "should_clear"),
    [
        ({}, True),
        ({"gap_revision": 5}, False),
        ({"watcher_status": "degraded"}, False),
        ({"health_error_code": "watcher_error"}, False),
    ],
)
def test_full_repair_clears_only_the_gap_it_started_with(user_a, overrides, should_clear):
    binding = FileSyncBinding(
        user_id=user_a.id,
        source=FileSyncSource.LOCAL_DIRECTORY,
        root_fingerprint="synthetic-root",
        watcher_status=overrides.get("watcher_status", "ready"),
        health_error_code=overrides.get("health_error_code"),
        needs_reconcile=True,
        gap_revision=overrides.get("gap_revision", 4),
    )
    cleared = clear_reconcile_gap_if_current(
        binding,
        gap_revision_at_start=4,
        mode="integrity_full",
        dry_run=False,
        allow_delete=True,
    )
    assert cleared is should_clear
    assert binding.needs_reconcile is (not should_clear)


def test_dry_run_and_partial_repair_never_clear_manual_reconcile_marker(user_a):
    binding = FileSyncBinding(
        user_id=user_a.id, source=FileSyncSource.LOCAL_DIRECTORY,
        root_fingerprint="synthetic-root", watcher_status="ready", needs_reconcile=True,
        gap_revision=0,
    )
    for kwargs in (
        {"dry_run": True, "allow_delete": True},
        {"dry_run": False, "allow_delete": False},
    ):
        assert not clear_reconcile_gap_if_current(
            binding, gap_revision_at_start=0, mode="integrity_full", **kwargs,
        )
        assert binding.needs_reconcile is True


def test_full_repair_can_clear_gap_even_when_path_conflicts_are_reported(user_a):
    """冲突独立展示；完整扫描覆盖缺口后不应让 watcher 异常标记永久残留。"""
    binding = FileSyncBinding(
        user_id=user_a.id, source=FileSyncSource.LOCAL_DIRECTORY,
        root_fingerprint="synthetic-root", watcher_status="ready", needs_reconcile=True,
        gap_revision=0,
    )
    assert clear_reconcile_gap_if_current(
        binding,
        gap_revision_at_start=0,
        mode="integrity_full",
        dry_run=False,
        allow_delete=True,
    )
    assert binding.needs_reconcile is False
