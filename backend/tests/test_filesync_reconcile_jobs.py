"""保护手动核对任务的持久状态、隔离和执行互斥契约。"""
from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core.tz import now_utc
from app.models import FileSyncBinding, FileSyncReconcileRun
from app.services.filesync.protocol import record_canonical_file_change
from app.services.filesync.jobs import (
    ReconcileRunError,
    claim_next_run,
    enqueue_reconcile_run,
    finish_run,
    get_reconcile_run,
    request_run_cancel,
)
from app.api.v1.filesync import (
    BindingRequest,
    ReconcileRequest,
    cancel_run,
    create_or_reconcile_binding,
    dry_run,
    reconcile_binding,
    run_status,
)
from app.api.v1.filesync_admin import (
    BindingActionRequest,
    binding_dry_run as admin_dry_run,
    binding_initialize as admin_initialize,
)


async def _binding(db, user, *, root_fingerprint="a" * 64):
    row = FileSyncBinding(
        user_id=user.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=root_fingerprint,
        revision=3,
    )
    db.add(row)
    await db.flush()
    return row


async def _finish_clean_repair(db, user, binding):
    run = await enqueue_reconcile_run(
        db, user_id=user.id, binding_id=binding.id, action="repair", allow_delete=False,
    )
    claimed = await claim_next_run(db, "worker-a", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    claimed.result_counts = {
        "created": 0, "updated": 0, "moved": 0, "deleted": 0,
        "skipped": 0, "conflicts": 0, "failed": 0,
    }
    await db.commit()
    assert await finish_run(
        db, run.id, "worker-a", status="succeeded", reconciliation_complete=True,
    )
    await db.refresh(binding)


@pytest.mark.asyncio
async def test_run_enqueue_is_owned_deduplicated_and_dry_run_cannot_delete(db, user_a, user_b):
    binding = await _binding(db, user_a)
    first = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="dry_run",
    )
    again = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="dry_run",
    )
    assert first.id == again.id
    assert await get_reconcile_run(db, first.id, user_id=user_b.id) is None
    with pytest.raises(ReconcileRunError, match="预检"):
        await enqueue_reconcile_run(
            db, user_id=user_a.id, binding_id=binding.id,
            action="dry_run", allow_delete=True,
        )


@pytest.mark.asyncio
async def test_claim_serializes_each_user_and_respects_global_limit(db, user_a, user_b):
    binding_a = await _binding(db, user_a)
    binding_a_second = await _binding(db, user_a, root_fingerprint="d" * 64)
    binding_b = await _binding(db, user_b, root_fingerprint="b" * 64)
    run_a = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding_a.id, action="repair",
    )
    run_a_second = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding_a_second.id, action="repair",
    )
    run_b = await enqueue_reconcile_run(
        db, user_id=user_b.id, binding_id=binding_b.id, action="initialize",
    )

    claimed = await claim_next_run(db, "worker-a", concurrency=1, now=now_utc())
    assert claimed is not None and claimed.id == run_a.id
    assert await claim_next_run(db, "worker-b", concurrency=1, now=now_utc()) is None

    next_claim = await claim_next_run(db, "worker-b", concurrency=2, now=now_utc())
    assert next_claim is not None and next_claim.id == run_b.id
    assert await claim_next_run(db, "worker-c", concurrency=2, now=now_utc()) is None
    assert await finish_run(db, next_claim.id, "worker-b", status="succeeded")
    assert await claim_next_run(db, "worker-c", concurrency=2, now=now_utc()) is None
    assert await finish_run(db, run_a.id, "worker-a", status="succeeded")
    final_claim = await claim_next_run(db, "worker-c", concurrency=2, now=now_utc())
    assert final_claim is not None and final_claim.id == run_a_second.id


@pytest.mark.asyncio
async def test_queued_cancel_is_terminal_but_running_cancel_waits_for_worker(db, user_a):
    binding = await _binding(db, user_a)
    queued = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    cancelled = await request_run_cancel(db, queued.id, user_id=user_a.id)
    assert cancelled is not None and cancelled.status == "cancelled"

    other_binding = await _binding(db, user_a, root_fingerprint="c" * 64)
    running = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=other_binding.id, action="repair",
    )
    claimed = await claim_next_run(db, "worker-a", concurrency=1, now=now_utc())
    assert claimed is not None and claimed.id == running.id
    cancelling = await request_run_cancel(db, running.id, user_id=user_a.id)
    assert cancelling is not None and cancelling.status == "cancelling"
    assert cancelling.cancel_requested is True
    assert await finish_run(db, running.id, "worker-a", status="cancelled")


@pytest.mark.parametrize(
    "initial_state",
    [
        pytest.param((True, "python_event_queue_overflow", "ready", None), id="covered-gap"),
        pytest.param((False, "python_event_queue_overflow", "ready", None), id="stale-overflow"),
        pytest.param((True, "event_buffer_overflow", "ready", None), id="path-buffer-overflow"),
        pytest.param((True, "sidecar_unavailable", "degraded", "sidecar_unavailable"),
                     id="persistent-error"),
    ],
)
@pytest.mark.asyncio
async def test_clean_repair_clears_only_recovered_overflow_state(
    db, user_a, initial_state,
):
    needs_reconcile, error_code, expected_status, expected_error = initial_state
    binding = await _binding(db, user_a)
    binding.needs_reconcile = needs_reconcile
    binding.gap_revision = 5
    binding.watcher_status = "degraded"
    binding.health_error_code = error_code
    await db.commit()
    await _finish_clean_repair(db, user_a, binding)

    assert binding.last_reconciled_at is not None
    assert binding.needs_reconcile is False
    assert binding.watcher_status == expected_status
    assert binding.health_error_code == expected_error
    assert binding.health_revision == 1


@pytest.mark.asyncio
async def test_successful_initialization_records_first_full_scan_without_erasing_gap(db, user_a):
    binding = await _binding(db, user_a)
    binding.needs_reconcile = True
    await db.commit()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="initialize",
    )
    claimed = await claim_next_run(db, "worker-a", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    assert await finish_run(
        db, run.id, "worker-a", status="succeeded", reconciliation_complete=True,
    )
    await db.refresh(binding)

    assert binding.last_reconciled_at is not None
    assert binding.needs_reconcile is True


@pytest.mark.asyncio
async def test_repair_does_not_clear_new_gap_or_cancelled_run(db, user_a):
    binding = await _binding(db, user_a)
    binding.needs_reconcile = True
    binding.gap_revision = 2
    binding.watcher_status = "degraded"
    binding.health_error_code = "python_event_queue_overflow"
    await db.commit()
    run = await enqueue_reconcile_run(db, user_id=user_a.id, binding_id=binding.id, action="repair")
    claimed = await claim_next_run(db, "worker-a", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    binding.gap_revision += 1
    await db.commit()

    assert await finish_run(
        db, run.id, "worker-a", status="succeeded", reconciliation_complete=True,
    )
    await db.refresh(binding)
    assert binding.last_reconciled_at is not None
    assert binding.needs_reconcile is True
    assert binding.watcher_status == "degraded"
    assert binding.health_error_code == "python_event_queue_overflow"
    assert binding.health_revision == 0

    reconciled_at = binding.last_reconciled_at
    second = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    next_claim = await claim_next_run(db, "worker-a", now=now_utc())
    assert next_claim is not None and next_claim.id == second.id
    await request_run_cancel(db, second.id, user_id=user_a.id)
    assert await finish_run(
        db, second.id, "worker-a", status="succeeded", reconciliation_complete=True,
    )
    await db.refresh(binding)
    cancelled = await get_reconcile_run(db, second.id)
    assert cancelled is not None and cancelled.status == "cancelled"
    assert binding.needs_reconcile is True
    assert binding.last_reconciled_at == reconciled_at


@pytest.mark.asyncio
async def test_expired_worker_task_fails_instead_of_being_retried(db, user_a):
    binding = await _binding(db, user_a)
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    timestamp = now_utc()
    claimed = await claim_next_run(db, "worker-old", concurrency=1, now=timestamp)
    assert claimed is not None and claimed.id == run.id

    assert await claim_next_run(
        db, "worker-new", concurrency=1, now=timestamp + timedelta(seconds=61),
    ) is None
    stored = await db.scalar(select(FileSyncReconcileRun).where(FileSyncReconcileRun.id == run.id))
    assert stored is not None
    assert stored.status == "failed"
    assert stored.error_code == "worker_interrupted"
    assert stored.lease_owner is None


@pytest.mark.asyncio
async def test_user_and_admin_entrypoints_enqueue_tasks_without_waiting_for_scan(
    db, user_a, user_b, monkeypatch,
):
    import app.api.v1.filesync as user_api

    binding = await _binding(db, user_a)
    await db.commit()
    async def prepared_binding(*_args, **_kwargs):
        return binding
    monkeypatch.setattr(user_api, "prepare_local_binding", prepared_binding)

    user_run = await dry_run(
        BindingRequest(root_path=".", mode="bidirectional"), user=user_a, db=db,
    )
    assert user_run["bindingId"] == binding.id
    assert user_run["status"] == "queued"
    with pytest.raises(HTTPException) as missing:
        await run_status(UUID(user_run["id"]), user=user_b, db=db)
    assert missing.value.status_code == 404

    await cancel_run(UUID(user_run["id"]), user=user_a, db=db)
    stored = await get_reconcile_run(db, UUID(user_run["id"]), user_id=user_a.id)
    assert stored is not None and stored.status == "cancelled"

    initialized = await create_or_reconcile_binding(
        BindingRequest(root_path=".", mode="bidirectional", confirm=True),
        user=user_a,
        db=db,
    )
    assert initialized["action"] == "initialize"
    assert initialized["allowDelete"] is False
    await cancel_run(UUID(initialized["id"]), user=user_a, db=db)

    repair = await reconcile_binding(
        binding.id,
        ReconcileRequest(confirm=True, allow_delete=True),
        user=user_a,
        db=db,
    )
    assert repair["action"] == "repair"
    assert repair["allowDelete"] is True
    await cancel_run(UUID(repair["id"]), user=user_a, db=db)

    admin_init = await admin_initialize(
        binding.id,
        BindingActionRequest(confirm=True),
        db=db,
    )
    assert admin_init["action"] == "initialize"
    await request_run_cancel(db, UUID(admin_init["id"]), user_id=user_a.id)

    admin_run = await admin_dry_run(binding.id, db=db)
    assert admin_run["status"] == "queued"
    assert admin_run["bindingId"] == binding.id


@pytest.mark.asyncio
async def test_mirror_out_is_queued_for_file_library_changes_outside_export_root(
    db, user_a, monkeypatch, tmp_path,
):
    import app.services.filesync.protocol as protocol
    import app.services.filesync.bindings as bindings

    user_root = tmp_path / str(user_a.id)
    (user_root / "export").mkdir(parents=True)
    (user_root / "个人文件").mkdir()
    settings = SimpleNamespace(
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
        filesync=SimpleNamespace(enabled=True),
    )
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="mirror_out",
        status="active",
        root_path="export",
        root_fingerprint="e" * 64,
    )
    db.add(binding)
    await db.commit()

    await record_canonical_file_change(
        db,
        user_id=user_a.id,
        storage_key=f"{user_a.id}/个人文件/源文件.txt",
        observed_fingerprint="f" * 64,
    )
    await db.commit()

    task = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
    ))
    assert task is not None
    assert task.action == "mirror_out"
    assert task.status == "queued"
    assert binding.revision == 1
