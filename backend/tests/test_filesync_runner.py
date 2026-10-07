"""端到端保护异步任务从持久队列到短批次投影的可观察契约。"""
import asyncio
import os
import queue
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.tz import now_utc
from app.db import session as db_session
from app.models import (
    File,
    FileSyncBinding,
    FileSyncJournal,
    FileSyncOutbox,
    FileSyncReconcileRun,
)
from app.services.filesync.jobs import claim_next_run, enqueue_reconcile_run
from app.services.filesync.reconcile import _root_fingerprint
from app.services.filesync.runner import (
    _cleanup_stale_scan_artifacts,
    _publish_latest_progress,
    _run_claimed,
    run_reconcile_worker,
)


@pytest.mark.asyncio
async def test_initialize_task_imports_disk_files_and_persists_terminal_results(
    db, user_a, monkeypatch,
):
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    settings = runner.get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    (root / "个人文件").mkdir(parents=True)
    (root / "个人文件" / "新建.txt").write_text("from disk", encoding="utf-8")
    runtime_workspace = root / "workspace" / "default"
    runtime_workspace.mkdir(parents=True)
    (runtime_workspace / "不属于文件库.txt").write_text("keep out of File projection", encoding="utf-8")
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="initialize",
    )
    await db.commit()
    worker_stop = asyncio.Event()
    worker_task = asyncio.create_task(run_reconcile_worker(
        worker_stop, worker_id="runner-test", session_factory=db_session._SessionLocal,
    ))
    try:
        for _ in range(200):
            await asyncio.sleep(0.05)
            async with db_session._SessionLocal() as check:
                stored = await check.get(FileSyncReconcileRun, run.id)
                if stored is not None and stored.status in {"succeeded", "failed", "cancelled"}:
                    break
        else:
            pytest.fail("任务 Worker 未在测试时间内完成初始化核对")
    finally:
        worker_stop.set()
        await asyncio.wait_for(worker_task, timeout=5)

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/新建.txt",
        ))
        journals = list((await check.scalars(select(FileSyncJournal).where(
            FileSyncJournal.binding_id == binding.id,
        ))).all())

    assert stored_run is not None
    assert stored_run.status == "succeeded", (
        stored_run.error_code,
        stored_run.result_counts,
    )
    assert stored_run.scanned_count == 5
    assert stored_run.result_counts["created"] == 1
    assert file is not None and file.size_bytes == len(b"from disk")
    assert any(item.object_type == "file" for item in journals)
    version = file.version

    repair_run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()
    claimed_repair = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed_repair is not None and claimed_repair.id == repair_run.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed_repair,
            "runner-test",
            asyncio.Event(),
        )
    async with db_session._SessionLocal() as check:
        repaired_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/新建.txt",
        ))
        repeated_journals = list((await check.scalars(select(FileSyncJournal).where(
            FileSyncJournal.binding_id == binding.id,
        ))).all())
    assert repaired_file is not None and repaired_file.version == version
    assert len(repeated_journals) == len(journals)


@pytest.mark.asyncio
async def test_dry_run_reports_plan_without_business_side_effects(db, user_a, monkeypatch):
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    (root / "个人文件").mkdir(parents=True)
    (root / "个人文件" / "仅预检.txt").write_text("preview", encoding="utf-8")
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="dry_run",
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed, "runner-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        files = list((await check.scalars(select(File).where(File.user_id == user_a.id))).all())
        journals = list((await check.scalars(select(FileSyncJournal).where(
            FileSyncJournal.binding_id == binding.id,
        ))).all())
        outbox = list((await check.scalars(select(FileSyncOutbox).where(
            FileSyncOutbox.user_id == user_a.id,
        ))).all())

    assert stored_run is not None and stored_run.status == "succeeded", (
        stored_run.status if stored_run else None,
        stored_run.error_code if stored_run else None,
        stored_run.result_counts if stored_run else None,
    )
    assert stored_run.result_counts["plannedCreated"] == 2
    assert stored_run.result_counts["created"] == 0
    assert files == []
    assert journals == []
    assert outbox == []


@pytest.mark.asyncio
async def test_confirmed_repair_hashes_same_stat_update_and_applies_missing_file_delete(
    db, user_a, monkeypatch,
):
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted
    from app.services.filesync.reconcile import SyncSummary

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    personal = root / "个人文件"
    nested = personal / "分类"
    nested.mkdir(parents=True)
    changed_path = nested / "等长更新.txt"
    deleted_path = nested / "确认删除.txt"
    move_source = personal / "移动源.txt"
    move_target = nested / "移动后.txt"
    changed_path.write_bytes(b"before")
    deleted_path.write_bytes(b"remove me")
    move_source.write_bytes(b"move contents")
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    initialize = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="initialize",
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == initialize.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed, "runner-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        changed_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/分类/等长更新.txt",
        ))
        deleted_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/分类/确认删除.txt",
        ))
        moved_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/移动源.txt",
        ))
        assert changed_file is not None and deleted_file is not None and moved_file is not None
        original_version = changed_file.version
        moved_file_id = moved_file.id
        original_stat = changed_path.stat()

    changed_path.write_bytes(b"after!")
    os.utime(changed_path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    deleted_path.unlink()
    move_source.rename(move_target)
    repair = await enqueue_reconcile_run(
        db,
        user_id=user_a.id,
        binding_id=binding.id,
        action="repair",
        allow_delete=True,
    )
    await db.commit()
    claimed_repair = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed_repair is not None and claimed_repair.id == repair.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed_repair,
            "runner-test",
            asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, repair.id)
        updated = await check.scalar(select(File).where(File.id == changed_file.id))
        deleted = await check.scalar(select(File).where(File.id == deleted_file.id))
        moved = await check.scalar(select(File).where(File.id == moved_file_id))

    assert stored_run is not None and stored_run.status == "succeeded"
    assert stored_run.result_counts["updated"] == 1
    assert stored_run.result_counts["deleted"] == 1
    assert stored_run.result_counts["moved"] == 1
    assert updated is not None and updated.version == original_version + 1
    assert deleted is not None and deleted.deleted_at is not None
    assert moved is not None and moved.storage_key == f"{user_a.id}/个人文件/分类/移动后.txt"

    changed_path.write_bytes(b"reject")
    move_target.write_bytes(b"move updated")
    monkeypatch.setattr(runner, "_DB_BATCH_SIZE", 2)
    project_batch = runner.project_path_events
    projection_calls = 0

    async def fail_second_batch(*args, **kwargs):
        nonlocal projection_calls
        projection_calls += 1
        if projection_calls == 2:
            return SyncSummary(rejected=1)
        return await project_batch(*args, **kwargs)

    monkeypatch.setattr(runner, "project_path_events", fail_second_batch)
    partial = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()
    claimed_partial = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed_partial is not None and claimed_partial.id == partial.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed_partial,
            "runner-test",
            asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        partial_run = await check.get(FileSyncReconcileRun, partial.id)
        unchanged = await check.scalar(select(File).where(File.id == changed_file.id))

    assert partial_run is not None and partial_run.status == "failed"
    assert partial_run.error_code == "path_projection_failed"
    assert partial_run.result_counts["failed"] == 1
    assert partial_run.result_counts["updated"] + partial_run.result_counts["foldersUpdated"] > 0
    assert unchanged is not None and unchanged.version >= updated.version


@pytest.mark.asyncio
async def test_stale_scan_artifact_cleanup_preserves_active_runs_and_progress_is_bounded(
    tmp_path, monkeypatch,
):
    import app.services.filesync.runner as runner

    active_id = uuid4()
    finished_id = uuid4()
    active_dir = tmp_path / f"gugu-filesync-{active_id}-worker"
    finished_dir = tmp_path / f"gugu-filesync-{finished_id}-worker"
    unrelated_dir = tmp_path / "gugu-filesync-not-a-run"
    active_dir.mkdir()
    finished_dir.mkdir()
    unrelated_dir.mkdir()
    active_dir.chmod(0o700)
    finished_dir.chmod(0o700)
    monkeypatch.setattr(runner.tempfile, "gettempdir", lambda: str(tmp_path))

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _model, run_id):
            if run_id == active_id:
                return SimpleNamespace(status="running")
            return SimpleNamespace(status="failed")

        async def rollback(self):
            return None

    await _cleanup_stale_scan_artifacts(lambda: FakeSession())
    assert active_dir.exists()
    assert not finished_dir.exists()
    assert unrelated_dir.exists()

    progress: queue.Queue[tuple[int, int]] = queue.Queue(maxsize=1)
    _publish_latest_progress(progress, 10, 1000)
    _publish_latest_progress(progress, 20, 2000)
    assert progress.qsize() == 1
    assert progress.get_nowait() == (20, 2000)
