"""保护每周完整核对的活跃范围、幂等排队与非破坏性默认值。"""
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select, func

from app.core.tz import now_utc
from app.models import FileSyncBinding, FileSyncReconcileRun
from app.services.filesync.periodic import enqueue_due_weekly_reconciles


@pytest.mark.asyncio
async def test_weekly_scheduler_enqueues_only_due_active_user_bindings(
    db, user_a, user_b, monkeypatch,
):
    import app.services.filesync.periodic as periodic

    timestamp = now_utc()
    user_a.is_active = True
    user_a.last_active_at = timestamp
    user_b.is_active = True
    user_b.last_active_at = timestamp - timedelta(days=30)
    due = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint="a" * 64, revision=1,
        last_reconciled_at=timestamp - timedelta(days=8),
    )
    inactive = FileSyncBinding(
        user_id=user_b.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint="b" * 64, revision=1,
    )
    recently_checked = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint="c" * 64, revision=1,
        last_reconciled_at=timestamp - timedelta(days=2),
    )
    db.add_all((due, inactive, recently_checked))
    await db.flush()
    monkeypatch.setattr(periodic, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(enabled=True, active_window_days=7),
    ))

    first_count = await enqueue_due_weekly_reconciles(db, now=timestamp)
    second_count = await enqueue_due_weekly_reconciles(db, now=timestamp)
    runs = (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == due.id,
    ))).all()
    total = await db.scalar(select(func.count()).select_from(FileSyncReconcileRun))

    assert first_count == second_count == 1
    assert total == 1
    assert len(runs) == 1
    assert runs[0].action == "repair"
    assert runs[0].allow_delete is False
    assert await db.scalar(select(FileSyncReconcileRun.id).where(
        FileSyncReconcileRun.binding_id.in_((inactive.id, recently_checked.id)),
    )) is None


@pytest.mark.asyncio
async def test_weekly_scheduler_backs_off_after_a_failed_full_scan(db, user_a, monkeypatch):
    import app.services.filesync.periodic as periodic

    timestamp = now_utc()
    user_a.is_active = True
    user_a.last_active_at = timestamp
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint="d" * 64, revision=1,
    )
    db.add(binding)
    await db.flush()
    db.add(FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, action="repair", allow_delete=False,
        status="failed", stage="failed", root_fingerprint=binding.root_fingerprint,
        finished_at=timestamp - timedelta(hours=2),
    ))
    await db.commit()
    monkeypatch.setattr(periodic, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(enabled=True, active_window_days=7),
    ))

    count = await enqueue_due_weekly_reconciles(db, now=timestamp)
    assert count == 0
