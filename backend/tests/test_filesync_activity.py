from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.core.config import FileSyncSettings
from app.core.tz import now_utc
from app.models import (
    FileSyncBinding, FileSyncJournal, FileSyncReconcileRun, FileSyncUserScanState,
)
from app.services.filesync.activity import evaluate_daily_cycle
from app.services.filesync.jobs import enqueue_due_jobs
from app.services.filesync.protocol import record_change
from app.models import FileSyncReconcileRun
from sqlalchemy import select


def test_filesync_configuration_has_no_implicit_periodic_integrity_scan():
    settings = FileSyncSettings()

    assert settings.compensation_interval_seconds == 86400
    assert not hasattr(settings, "integrity_interval_seconds")


@pytest.mark.asyncio
async def test_observed_file_events_advance_user_watermark_but_projection_does_not(
    db, user_a, monkeypatch,
):
    import app.services.filesync.protocol as protocol

    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    binding = FileSyncBinding(
        user_id=user_a.id,
        source="local_directory",
        status="active",
        root_path=".",
        root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()

    args = dict(
        db=db,
        binding=binding,
        user_id=user_a.id,
        source="local_directory",
        operation="update",
        relative_path="note.md",
        idempotency_key="observed-change-1",
        observed_fingerprint="b" * 64,
    )
    await record_change(**args)
    await record_change(**args)
    state = await db.get(FileSyncUserScanState, user_a.id)
    assert state.activity_seq == 1
    journal = await db.scalar(select(FileSyncJournal).where(
        FileSyncJournal.idempotency_key == "observed-change-1",
    ))
    assert journal.dirty_revision == 1

    await record_change(
        **{**args, "idempotency_key": "reconcile-projection-1"},
        mark_dirty=False,
    )
    await db.refresh(state)
    assert state.activity_seq == 1
    projection_journal = await db.scalar(select(FileSyncJournal).where(
        FileSyncJournal.idempotency_key == "reconcile-projection-1",
    ))
    assert projection_journal.dirty_revision is None


@pytest.mark.asyncio
async def test_daily_cycle_skips_only_when_reliable_observed_activity_exists(db, user_a):
    now = now_utc()
    state = FileSyncUserScanState(
        user_id=user_a.id,
        activity_seq=5,
        cycle_activity_seq=4,
        current_cycle_cutoff=now - timedelta(days=1, seconds=1),
        activity_reliable=True,
    )
    db.add(state)
    await db.flush()

    result = await evaluate_daily_cycle(db, state, now=now)

    assert result == "skipped_file_active"
    assert state.last_cycle_decision == "skipped_file_active"
    assert state.skip_reason == "file_activity"
    assert state.previous_cycle_cutoff == now - timedelta(days=1, seconds=1)
    assert state.current_cycle_cutoff == now
    assert state.cycle_activity_seq == 5


@pytest.mark.asyncio
async def test_unreliable_activity_tracking_never_skips_daily_snapshot(db, user_a):
    now = now_utc()
    state = FileSyncUserScanState(
        user_id=user_a.id,
        activity_seq=5,
        cycle_activity_seq=4,
        current_cycle_cutoff=now - timedelta(days=1, seconds=1),
        activity_reliable=False,
    )
    db.add(state)
    await db.flush()

    result = await evaluate_daily_cycle(db, state, now=now)

    assert result == "scan"
    assert state.skip_reason is None


@pytest.mark.asyncio
async def test_daily_scheduler_records_active_skip_without_claiming_success(
    db, user_a, monkeypatch,
):
    import app.services.filesync.jobs as jobs

    now = now_utc()
    binding = FileSyncBinding(
        user_id=user_a.id,
        source="local_directory",
        status="active",
        root_path=".",
        root_fingerprint="c" * 64,
        baseline_generation="baseline-generation",
        last_daily_reconciled_at=None,
    )
    state = FileSyncUserScanState(
        user_id=user_a.id,
        activity_seq=9,
        cycle_activity_seq=8,
        current_cycle_cutoff=now - timedelta(days=1, seconds=1),
        activity_reliable=True,
    )
    db.add_all([binding, state])
    await db.commit()

    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(compensation_interval_seconds=86400),
    ))
    class SessionContext:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *_args):
            return False

    await enqueue_due_jobs(SessionContext)

    await db.refresh(binding)
    await db.refresh(state)
    runs = (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
    ))).all()
    assert len(runs) == 1
    assert runs[0].status == "cancelled"
    assert runs[0].error_code == "skipped_file_active"
    assert state.last_cycle_decision == "skipped_file_active"
    assert state.skip_reason == "file_activity"
    assert binding.last_daily_reconciled_at is None


@pytest.mark.asyncio
async def test_local_activity_does_not_skip_mirror_out_daily_export(db, user_a, monkeypatch):
    import app.services.filesync.jobs as jobs

    now = now_utc()
    local = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path="local", root_fingerprint="e" * 64,
        baseline_generation="local-baseline", next_reconcile_at=now - timedelta(seconds=1),
    )
    mirror_out = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_out",
        status="active", root_path="export", root_fingerprint="f" * 64,
        baseline_generation="out-baseline", next_reconcile_at=now - timedelta(seconds=1),
    )
    state = FileSyncUserScanState(
        user_id=user_a.id, activity_seq=3, cycle_activity_seq=2,
        current_cycle_cutoff=now - timedelta(days=1, seconds=1),
        activity_reliable=True,
    )
    db.add_all((local, mirror_out, state))
    await db.commit()

    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(compensation_interval_seconds=86400),
    ))

    class SessionContext:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *_args):
            return False

    await enqueue_due_jobs(SessionContext)

    runs = (await db.scalars(select(FileSyncReconcileRun).order_by(
        FileSyncReconcileRun.binding_id,
    ))).all()
    local_run = next(run for run in runs if run.binding_id == local.id)
    export_run = next(run for run in runs if run.binding_id == mirror_out.id)
    assert local_run.error_code == "skipped_file_active"
    assert local_run.status == "cancelled"
    assert export_run.reason == "daily"
    assert export_run.mode == "mirror_out"
    assert export_run.status == "queued"


@pytest.mark.asyncio
async def test_queued_daily_run_does_not_make_watcher_activity_unreliable(
    db, user_a, monkeypatch, tmp_path,
):
    """未开始的每日任务入队后，仍须保留活动可靠性供 claim 时二次判断。"""
    import app.services.filesync.watcher as watcher

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path=".", root_fingerprint="d" * 64,
    )
    db.add(binding)
    await db.flush()
    db.add_all((
        FileSyncUserScanState(user_id=user_a.id, activity_reliable=False),
        FileSyncReconcileRun(
            user_id=user_a.id, binding_id=binding.id, mode="snapshot_diff",
            reason="daily", status="queued",
        ),
    ))
    await db.commit()

    root = tmp_path / "workspace"
    root.mkdir()
    manager = watcher.FileSyncWatcherManager()
    manager._binding_roots[binding.id] = root
    monkeypatch.setattr(manager, "_active_user_ids", lambda *_: _resolved({user_a.id}))
    monkeypatch.setattr(watcher, "_binding_root", lambda *_: _resolved(root))

    await manager._refresh_sidecar_bindings(db, [binding], set())

    state = await db.get(FileSyncUserScanState, user_a.id)
    assert state.activity_reliable is True


async def _resolved(value):
    return value
