from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import File, FileSyncBinding, FileSyncReconcileRun


def test_reconcile_run_dto_shares_user_fields_without_exposing_admin_fields():
    """用户任务与 Admin 任务共享状态字段，但 checkpoint/user id 只给 Admin。"""
    from uuid import uuid4

    from app.services.filesync.job_api import reconcile_run_result

    row = SimpleNamespace(
        id=uuid4(), binding_id=8, user_id=uuid4(), mode="snapshot_diff",
        reason="daily", status="paused", stage="scanning", dry_run=False,
        allow_delete=False, progress_current=12, progress_total=None,
        result_counts={"scanned": 12}, error_code=None, pause_reason="scan_slice",
        next_run_at=None, cumulative_runtime_seconds=20, checkpoint_ref="private-ref",
        created_at=None, started_at=None, finished_at=None,
    )

    user_result = reconcile_run_result(row)
    admin_result = reconcile_run_result(row, include_admin_fields=True)

    assert user_result["status"] == admin_result["status"] == "paused"
    assert user_result["resultCounts"] == admin_result["resultCounts"] == {"scanned": 12}
    assert "checkpointRef" not in user_result
    assert "userId" not in user_result
    assert admin_result["checkpointRef"] == "private-ref"
    assert admin_result["userId"] == str(row.user_id)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("confirm", "confirm_delete", "expected_dry_run", "expected_allow_delete"),
    [(False, False, True, False), (True, True, False, True)],
)
async def test_binding_api_persists_confirmation_without_projecting_in_request(
    db, user_a, monkeypatch, tmp_path,
    confirm, confirm_delete, expected_dry_run, expected_allow_delete,
):
    """绑定请求只排入任务，dry-run/删除确认语义写入任务而不同步投影。"""
    import app.api.v1.filesync as api
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol

    root = tmp_path / str(user_a.id) / "资料"
    root.mkdir(parents=True)
    (root / "note.txt").write_text("待异步扫描", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )

    monkeypatch.setattr(api, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(api, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(api, "resolve_local_binding_root", lambda _user, _path: ("资料", root))
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)

    result = await api.create_or_reconcile_binding(
        api.BindingRequest(
            root_path="资料", confirm=confirm, confirm_delete=confirm_delete,
        ),
        user=user_a,
        db=db,
    )

    run = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.user_id == user_a.id,
    ))
    assert result["status"] == "queued"
    assert run is not None and run.status == "queued"
    assert run.dry_run is expected_dry_run
    assert run.allow_delete is expected_allow_delete
    assert (await db.scalars(select(File).where(
        File.user_id == user_a.id,
        File.deleted_at.is_(None),
    ))).all() == []


@pytest.mark.asyncio
async def test_dry_run_api_queues_persistent_job_without_synchronous_projection(
    db, user_a, monkeypatch, tmp_path,
):
    """dry-run 请求只持久入队；不能在 HTTP handler 中扫描并写入文件库。"""
    import app.api.v1.filesync as api
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol

    root = tmp_path / str(user_a.id) / "资料"
    root.mkdir(parents=True)
    (root / "note.txt").write_text("待异步扫描", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
    )

    monkeypatch.setattr(api, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(api, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(api, "resolve_local_binding_root", lambda _user, _path: ("资料", root))
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)

    result = await api.dry_run(
        api.BindingRequest(root_path="资料"), user=user_a, db=db,
    )

    assert result["status"] == "queued"
    assert result["dryRun"] is True
    assert result["mode"] == "integrity_full"
    assert (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_a.id,
    ))).one_or_none() is not None
    run = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.user_id == user_a.id,
    ))
    assert run is not None and run.status == "queued" and run.dry_run is True
    assert (await db.scalars(select(File).where(
        File.user_id == user_a.id,
        File.deleted_at.is_(None),
    ))).all() == []


@pytest.mark.asyncio
async def test_user_cancel_api_returns_terminal_state_and_hides_other_users_jobs(
    db, user_a, user_b,
):
    """取消 API 只允许任务所有者操作，并立即返回可供队列 UI 更新的完整终态。"""
    from uuid import uuid4

    from fastapi import HTTPException

    import app.api.v1.filesync as api

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="synthetic-root",
    )
    db.add(binding)
    await db.flush()
    run = FileSyncReconcileRun(
        id=uuid4(), user_id=user_a.id, binding_id=binding.id,
        mode="snapshot_diff", reason="manual", status="queued", stage="claiming",
        dry_run=False, allow_delete=False, result_counts={},
    )
    db.add(run)
    await db.commit()

    with pytest.raises(HTTPException) as denied:
        await api.cancel_reconcile_job(str(run.id), user=user_b, db=db)
    assert denied.value.status_code == 404

    result = await api.cancel_reconcile_job(str(run.id), user=user_a, db=db)

    assert result["id"] == str(run.id)
    assert result["status"] == "cancelled"
    assert result["stage"] == "finished"
    assert result["errorCode"] == "cancelled"
    assert result["resultCounts"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(("run_status", "expected_status"), [
    ("queued", "cancelled"), ("running", "cancelling"),
])
async def test_admin_unbind_preserves_library_files_and_cancels_binding_jobs(
    db, user_a, run_status, expected_status,
):
    """解绑停用绑定、取消等待任务并请求运行任务停止，但保留已投影文件。"""
    import asyncio
    from uuid import uuid4

    from fastapi import HTTPException

    import app.api.v1.filesync_admin as admin_api
    from app.core.tz import now_utc
    from app.services.filesync.job_lifecycle import THREAD_STOPS

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="资料", root_fingerprint="synthetic-root", scope_revision=3,
        baseline_generation="synthetic-generation",
    )
    projected_file = File(
        user_id=user_a.id, display_name="保留文件", ext="txt", space="personal",
        storage_key=f"{user_a.id}/资料/保留文件.txt", storage_backend="local",
        size="4", size_bytes=4, updated_at=now_utc(),
    )
    db.add_all([binding, projected_file])
    await db.flush()
    run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, mode="snapshot_diff",
        reason="manual", status=run_status,
        stage="scanning" if run_status == "running" else "claiming", result_counts={},
    )
    db.add(run)
    await db.flush()
    stop = asyncio.Event()
    if run_status == "running":
        THREAD_STOPS[str(run.id)] = stop
    try:
        with pytest.raises(HTTPException) as missing_confirmation:
            await admin_api.binding_unbind(
                binding.id, admin_api.BindingActionRequest(confirm=False), db,
            )
        assert missing_confirmation.value.status_code == 400

        result = await admin_api.binding_unbind(
            binding.id, admin_api.BindingActionRequest(confirm=True), db,
        )
        await db.commit()

        assert result == {"id": binding.id, "status": "inactive", "scopeRevision": 4}
        assert run.status == expected_status
        assert stop.is_set() is (run_status == "running")
        assert await db.get(File, projected_file.id) is not None
        with pytest.raises(HTTPException) as inactive_reconcile:
            await admin_api.binding_reconcile(
                binding.id, admin_api.BindingActionRequest(confirm=True), db,
            )
        assert inactive_reconcile.value.status_code == 409
    finally:
        THREAD_STOPS.pop(str(run.id), None)
