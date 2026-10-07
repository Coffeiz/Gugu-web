from __future__ import annotations

import asyncio
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.tz import now_utc
from app.models import (
    File, FileSyncBinding, FileSyncConflict, FileSyncJournal, FileSyncReconcileRun, Folder,
    Workspace, WorkspaceDirectory,
)
from app.services.filesync.file_ops import root_fingerprint
from app.services.filesync import jobs
from app.services.filesync.scan import ScanEntry


@pytest.mark.asyncio
async def test_conflict_detection_ignores_changes_owned_by_overlapping_binding(
    db, user_a, tmp_path,
):
    """父绑定不得把子绑定覆盖路径上的正常投影误报成双边冲突。"""
    from app.models import FileSyncConflict
    from app.services.filesync.conflicts import inspect_conflict_batch

    user_root = tmp_path / str(user_a.id)
    nested_root = user_root / "个人文件"
    nested_root.mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint="root-fingerprint",
    )
    file_row = File(
        user_id=user_a.id,
        display_name="doc",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/doc.txt",
        storage_backend="local",
        size="9",
        size_bytes=9,
        updated_at=now_utc(),
    )
    db.add_all([binding, file_row])
    await db.flush()
    db.add(FileSyncJournal(
        binding_id=binding.id,
        user_id=user_a.id,
        idempotency_key="old-parent-baseline",
        source="local_directory",
        operation="baseline",
        relative_path="个人文件/doc.txt",
        observed_fingerprint="a" * 64,
        status="synced",
        updated_at=now_utc() - timedelta(days=1),
    ))
    await db.flush()

    blocked = await inspect_conflict_batch(
        db,
        user_id=user_a.id,
        binding=binding,
        root=user_root,
        user_root=user_root,
        other_roots=(nested_root,),
        candidate_paths=("个人文件/doc.txt",),
        entries={"个人文件/doc.txt": ScanEntry(
            relative_path="个人文件/doc.txt",
            object_type="file",
            size_bytes=9,
            mtime_ns=1,
            ctime_ns=1,
            fingerprint="b" * 64,
            fingerprint_version=3_001_048_576,
        )},
        persist=True,
    )

    conflict = await db.scalar(select(FileSyncConflict).where(
        FileSyncConflict.binding_id == binding.id,
        FileSyncConflict.relative_path == "个人文件/doc.txt",
        FileSyncConflict.status == "pending",
    ))
    assert blocked == set()
    assert conflict is None


@pytest.mark.asyncio
async def test_workspace_binding_projects_files_and_empty_folders_to_its_directory(
    db, user_a, monkeypatch, tmp_path,
):
    """目录工作区整树任务应保留工作区归属，也不能丢弃空目录。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces
    from app.services.filesync.file_ops import root_fingerprint

    storage_root = tmp_path / "users"
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="研究工作区", directory_name="research",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name=directory.name, kind="directory",
        project_id=None, directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()

    root = storage_root / str(user_a.id) / "workspace" / directory.directory_name
    (root / "_tools" / "bin").mkdir(parents=True)
    (root / "_tools" / "empty").mkdir()
    (root / "_tools" / "bin" / "run.py").write_text("print('ok')", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(workspaces, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id, source="local_directory",
        status="active", mode="mirror_in", root_path=".",
        root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    queued = await jobs.enqueue_reconcile(
        db, binding, mode="integrity_full", reason="bootstrap",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claim = await jobs.claim_due_job(worker_db)
    assert claim is not None
    await jobs._run_claimed(db_session._SessionLocal, *claim)

    async with db_session._SessionLocal() as verify_db:
        run = await verify_db.get(FileSyncReconcileRun, queued.id)
        file_row = await verify_db.scalar(select(File).where(
            File.user_id == user_a.id, File.display_name == "run",
            File.deleted_at.is_(None),
        ))
        folders = (await verify_db.scalars(select(Folder).where(
            Folder.user_id == user_a.id, Folder.workspace_directory_id == directory.id,
            Folder.deleted_at.is_(None),
        ).order_by(Folder.name))).all()

    assert run is not None and run.status == "succeeded", run.error_code if run else None
    assert file_row is not None and file_row.space == "workspace"
    assert file_row.workspace_directory_id == directory.id
    assert len(folders) == 3
    assert {folder.name for folder in folders} == {"_tools", "bin", "empty"}
    assert all(folder.workspace_directory_id == directory.id for folder in folders)


@pytest.mark.asyncio
async def test_reconcile_job_projects_files_and_publishes_baseline_after_scan(
    db, user_a, monkeypatch, tmp_path,
):
    """首次整树任务应在独立扫描后分批投影，且只在成功事务后发布基线。"""
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    import app.services.filesync.snapshots as snapshots
    import app.services.workspaces as workspaces
    import app.services.filesync.outbox as outbox
    import app.db.session as db_session

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "个人文件"
    root.mkdir(parents=True)
    (root / "entry.md").write_text("synthetic fixture", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, targeted, snapshots):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint=root_fingerprint(user_root),
        watcher_status="ready", needs_reconcile=True, gap_revision=3,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    queued = await jobs.enqueue_reconcile(db, binding, reason="bootstrap", mode="integrity_full")
    assert queued.gap_revision_at_start == 3
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        file_row = await verify_db.scalar(select(File).where(
            File.user_id == user_a.id, File.display_name == "entry", File.deleted_at.is_(None),
        ))
        run = await verify_db.get(FileSyncReconcileRun, queued.id)
        refreshed_binding = await verify_db.get(FileSyncBinding, binding.id)
    assert run.status == "succeeded", run.error_code
    assert file_row is not None
    assert run.status == "succeeded"
    assert run.result_counts["created"] == 1
    assert run.cumulative_runtime_seconds > 0
    assert refreshed_binding.baseline_generation == run.candidate_generation
    assert refreshed_binding.baseline_dirty_revision == refreshed_binding.dirty_revision
    assert refreshed_binding.needs_reconcile is False


@pytest.mark.asyncio
async def test_reconcile_job_preserves_file_identity_when_directory_tree_moves_and_deletes(
    db, user_a, monkeypatch, tmp_path,
):
    """新任务路径需保留目录移动后的文件身份，并只在完整扫描后投影删除。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "个人文件"
    source = root / "source"
    source.mkdir(parents=True)
    (source / "report.txt").write_text("synthetic report", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    for module in (protocol, targeted):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    async def run_reconcile(reason: str):
        queued = await jobs.enqueue_reconcile(
            db, binding,
            mode="integrity_full" if reason == "bootstrap" else "snapshot_diff",
            reason=reason, allow_delete=True,
        )
        await db.commit()
        async with db_session._SessionLocal() as worker_db:
            claimed = await jobs.claim_due_job(worker_db)
        assert claimed is not None
        await jobs._run_claimed(db_session._SessionLocal, *claimed)
        async with db_session._SessionLocal() as result_db:
            return await result_db.get(FileSyncReconcileRun, queued.id)

    first = await run_reconcile("bootstrap")
    assert first.status == "succeeded", first.error_code
    file_row = await db.scalar(select(File).where(
        File.user_id == user_a.id, File.deleted_at.is_(None),
    ))
    old_folder = await db.scalar(select(Folder).where(
        Folder.user_id == user_a.id, Folder.name == "source", Folder.deleted_at.is_(None),
    ))
    assert file_row is not None and old_folder is not None
    original_file_id = file_row.id

    target = root / "archive" / "source"
    target.parent.mkdir()
    source.rename(target)
    moved = await run_reconcile("manual")
    assert moved.status == "succeeded", moved.error_code
    await db.refresh(file_row)
    await db.refresh(old_folder)
    assert file_row.id == original_file_id
    assert old_folder.deleted_at is not None
    assert file_row.folder_id != old_folder.id
    assert (await db.scalar(select(Folder).where(
        Folder.user_id == user_a.id, Folder.name == "source", Folder.deleted_at.is_(None),
    ))).id == file_row.folder_id
    assert moved.result_counts["moved"] == 1

    (target / "report.txt").unlink()
    target.rmdir()
    target.parent.rmdir()
    deleted = await run_reconcile("manual")
    assert deleted.status == "succeeded", deleted.error_code
    await db.refresh(file_row)
    assert file_row.deleted_at is not None
    assert deleted.result_counts["deleted"] >= 1


@pytest.mark.asyncio
async def test_canonical_file_write_during_baseline_publish_rejects_stale_generation_and_resumes(
    db, user_a, monkeypatch, tmp_path,
):
    """文件库正式写入在基线发布前到达时，旧代次不得覆盖它，续跑应发布新内容。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "个人文件"
    root.mkdir(parents=True)
    source_file = root / "note.txt"
    source_file.write_text("before event", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    for module in (protocol, targeted):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    initial_run = await jobs.enqueue_reconcile(
        db, binding, mode="integrity_full", reason="bootstrap",
    )
    await db.commit()
    async with db_session._SessionLocal() as initial_worker_db:
        initial_claim = await jobs.claim_due_job(initial_worker_db)
    assert initial_claim is not None
    await jobs._run_claimed(db_session._SessionLocal, *initial_claim)
    async with db_session._SessionLocal() as initial_state_db:
        initial_result = await initial_state_db.get(FileSyncReconcileRun, initial_run.id)
        initial_binding = await initial_state_db.get(FileSyncBinding, binding.id)
        initial_generation = initial_binding.baseline_generation
    assert initial_result.status == "succeeded", initial_result.error_code
    assert initial_generation is not None

    source_file.write_text("candidate during scan", encoding="utf-8")
    run = await jobs.enqueue_reconcile(
        db, binding, mode="snapshot_diff", reason="manual",
    )
    await db.commit()

    original_stage = baseline.FileSyncBaselineStore.stage
    stage_count = 0
    event_loop = asyncio.get_running_loop()

    async def record_canonical_write_during_candidate_staging():
        source_file.write_text("after event", encoding="utf-8")
        async with db_session._SessionLocal() as event_db:
            file_row = await event_db.scalar(select(File).where(
                File.user_id == user_a.id,
                File.storage_key == f"{user_a.id}/个人文件/note.txt",
                File.deleted_at.is_(None),
            ))
            assert file_row is not None
            file_row.size = str(source_file.stat().st_size)
            file_row.size_bytes = source_file.stat().st_size
            file_row.updated_at = now_utc()
            await event_db.flush()
            from app.services.filesync.file_ops import fingerprint
            await protocol.record_canonical_file_change(
                event_db,
                user_id=user_a.id,
                storage_key=file_row.storage_key,
                observed_fingerprint=fingerprint(source_file),
            )
            await event_db.commit()

    def stage_with_event(store, *args, **kwargs):
        nonlocal stage_count
        generation = original_stage(store, *args, **kwargs)
        stage_count += 1
        if stage_count == 1:
            asyncio.run_coroutine_threadsafe(
                record_canonical_write_during_candidate_staging(), event_loop,
            ).result()
        return generation

    monkeypatch.setattr(baseline.FileSyncBaselineStore, "stage", stage_with_event)
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as state_db:
        paused_run = await state_db.get(FileSyncReconcileRun, run.id)
        stale_binding = await state_db.get(FileSyncBinding, binding.id)
    assert stage_count == 1
    assert paused_run.status == "paused"
    assert paused_run.pause_reason == "dirty_events"
    assert stale_binding.baseline_generation == initial_generation
    assert stale_binding.dirty_revision == 1

    async with db_session._SessionLocal() as resume_db:
        resumed_run = await resume_db.get(FileSyncReconcileRun, run.id)
        resumed_run.next_run_at = now_utc() - timedelta(seconds=1)
        await resume_db.commit()
        claimed = await jobs.claim_due_job(resume_db)
    assert claimed is not None and claimed[0] == run.id
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        finished_run = await verify_db.get(FileSyncReconcileRun, run.id)
        finished_binding = await verify_db.get(FileSyncBinding, binding.id)
        file_row = await verify_db.scalar(select(File).where(
            File.user_id == user_a.id, File.deleted_at.is_(None),
        ))
    assert finished_run.status == "succeeded", finished_run.error_code
    assert finished_binding.baseline_generation == finished_run.candidate_generation
    assert finished_binding.baseline_dirty_revision == finished_binding.dirty_revision == 1
    assert file_row is not None and file_row.size_bytes == len(b"after event")


@pytest.mark.asyncio
async def test_failed_baseline_publish_rolls_back_pointer_and_preserves_file_snapshots(
    db, user_a, monkeypatch, tmp_path,
):
    """成功指针提交失败时保留旧基线、磁盘文件和冲突正文快照，只丢弃候选代次。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.job_projection as projection
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "个人文件"
    root.mkdir(parents=True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件", root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    async def run_one(mode: str, reason: str):
        run = await jobs.enqueue_reconcile(db, binding, mode=mode, reason=reason)
        await db.commit()
        async with db_session._SessionLocal() as worker_db:
            claim = await jobs.claim_due_job(worker_db)
        assert claim is not None
        await jobs._run_claimed(db_session._SessionLocal, *claim)
        async with db_session._SessionLocal() as verify_db:
            return await verify_db.get(FileSyncReconcileRun, run.id)

    initial_run = await run_one("integrity_full", "bootstrap")
    assert initial_run.status == "succeeded", initial_run.error_code
    async with db_session._SessionLocal() as state_db:
        initial_binding = await state_db.get(FileSyncBinding, binding.id)
        previous_generation = initial_binding.baseline_generation
    assert previous_generation is not None
    baseline_store = baseline.FileSyncBaselineStore(user_a.id, binding.id)
    previous_manifest = baseline_store.load(
        previous_generation, expected_root_fingerprint=binding.root_fingerprint,
    )
    assert dict(previous_manifest.entries) == {}

    source_file = root / "keep.txt"
    source_file.write_text("physical user data", encoding="utf-8")
    snapshots.save_snapshot(user_a.id, binding.id, "keep.txt", source_file)
    preserved_snapshot = snapshots.read_snapshot(user_a.id, binding.id, "keep.txt")
    assert preserved_snapshot == b"physical user data"

    staged_candidates = []
    original_stage = baseline.FileSyncBaselineStore.stage

    def stage_and_record(store, *args, **kwargs):
        generation = original_stage(store, *args, **kwargs)
        staged_candidates.append(generation)
        return generation

    monkeypatch.setattr(baseline.FileSyncBaselineStore, "stage", stage_and_record)
    original_publish_success = projection.publish_scan_success
    publication_attempts = []

    def fail_after_pointer_assignment(run, state, **kwargs):
        publication_attempts.append(kwargs["generation"])
        original_publish_success(run, state, **kwargs)
        raise RuntimeError("injected baseline transaction rollback")

    monkeypatch.setattr(projection, "publish_scan_success", fail_after_pointer_assignment)
    failed_run = await run_one("snapshot_diff", "manual")

    assert len(publication_attempts) == 1
    assert len(staged_candidates) == 1
    candidate_generation = staged_candidates[0]
    assert publication_attempts == [candidate_generation]
    assert failed_run.status == "failed"
    assert source_file.read_text(encoding="utf-8") == "physical user data"
    assert snapshots.read_snapshot(user_a.id, binding.id, "keep.txt") == preserved_snapshot
    with pytest.raises(FileNotFoundError):
        baseline_store.load(
            candidate_generation, expected_root_fingerprint=binding.root_fingerprint,
        )

    async with db_session._SessionLocal() as verify_db:
        final_binding = await verify_db.get(FileSyncBinding, binding.id)
        projected_file = await verify_db.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/keep.txt",
            File.deleted_at.is_(None),
        ))
    assert final_binding.baseline_generation == previous_generation
    assert dict(baseline_store.load(
        previous_generation, expected_root_fingerprint=binding.root_fingerprint,
    ).entries) == {}
    assert projected_file is not None


@pytest.mark.asyncio
async def test_quota_rejected_path_is_not_published_and_is_retried_after_capacity_returns(
    db, user_a, monkeypatch, tmp_path,
):
    """配额拒绝的文件不能被成功快照吞掉，容量恢复后后续对账仍会导入。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "个人文件"
    root.mkdir(parents=True)
    (root / "over-limit.txt").write_text("容量恢复后导入", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(
            enabled=True, reconcile_timeout_seconds=1800,
            reconcile_slice_seconds=10, reconcile_scan_batch_size=1000,
            reconcile_batch_size=200, reconcile_hash_chunk_bytes=1_048_576,
            reconcile_hash_concurrency=1, reconcile_write_concurrency=1,
            compensation_interval_seconds=86_400,
        ),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=1),
    )
    for module in (jobs, baseline, bindings, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path=".", root_fingerprint=root_fingerprint(user_root),
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    async def run_one(mode: str, reason: str):
        queued = await jobs.enqueue_reconcile(db, binding, mode=mode, reason=reason)
        await db.commit()
        async with db_session._SessionLocal() as worker_db:
            claim = await jobs.claim_due_job(worker_db)
        assert claim is not None
        await jobs._run_claimed(db_session._SessionLocal, *claim)
        async with db_session._SessionLocal() as verify_db:
            return await verify_db.get(FileSyncReconcileRun, queued.id)

    rejected_run = await run_one("integrity_full", "bootstrap")
    assert rejected_run.status == "succeeded"
    assert rejected_run.result_counts["rejected"] >= 1
    refreshed = await db.get(FileSyncBinding, binding.id)
    await db.refresh(refreshed)
    manifest = baseline.FileSyncBaselineStore(user_a.id, binding.id).load(
        refreshed.baseline_generation,
        expected_root_fingerprint=refreshed.root_fingerprint,
    )
    assert "个人文件/over-limit.txt" not in manifest.entries
    assert await db.scalar(select(File).where(
        File.user_id == user_a.id, File.deleted_at.is_(None),
    )) is None

    settings.quota.default_storage_limit_bytes = 1024
    retry_run = await run_one("snapshot_diff", "manual")
    assert retry_run.status == "succeeded"
    await db.refresh(refreshed)
    imported = await db.scalar(select(File).where(
        File.user_id == user_a.id, File.deleted_at.is_(None),
    ))
    assert imported is not None
    manifest = baseline.FileSyncBaselineStore(user_a.id, binding.id).load(
        refreshed.baseline_generation,
        expected_root_fingerprint=refreshed.root_fingerprint,
    )
    assert "个人文件/over-limit.txt" in manifest.entries


@pytest.mark.asyncio
@pytest.mark.parametrize(("user_limit", "replacement_size"), [(8, 8), (None, 32)])
async def test_tree_job_projects_deletions_before_using_quota_headroom(
    db, user_a, monkeypatch, tmp_path, user_limit, replacement_size,
):
    """任务配额不计外部 Shell 文件；删除释放空间和无上限配额都允许导入。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces

    storage_root = tmp_path / "users"
    root = storage_root / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    shell_root = storage_root / str(user_a.id) / "workspace"
    shell_root.mkdir(parents=True)
    (shell_root / "build.cache").write_bytes(b"x" * 128)
    old_path = root / "old.bin"
    old_path.write_bytes(b"o" * 8)
    user_a.storage_limit_bytes = user_limit
    settings = SimpleNamespace(
        filesync=SimpleNamespace(
            enabled=True, reconcile_timeout_seconds=1800,
            reconcile_slice_seconds=10, reconcile_scan_batch_size=1000,
            reconcile_batch_size=200, reconcile_hash_chunk_bytes=1_048_576,
            reconcile_hash_concurrency=1, reconcile_write_concurrency=1,
            compensation_interval_seconds=86_400,
        ),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=None),
    )
    for module in (jobs, baseline, bindings, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()

    async def run_reconcile(mode: str, reason: str):
        queued = await jobs.enqueue_reconcile(
            db, binding, mode=mode, reason=reason, allow_delete=True,
        )
        await db.commit()
        async with db_session._SessionLocal() as worker_db:
            claim = await jobs.claim_due_job(worker_db)
        assert claim is not None
        await jobs._run_claimed(db_session._SessionLocal, *claim)
        async with db_session._SessionLocal() as result_db:
            return await result_db.get(FileSyncReconcileRun, queued.id)

    first = await run_reconcile("integrity_full", "bootstrap")
    assert first.status == "succeeded", first.error_code
    old_row = await db.scalar(select(File).where(
        File.user_id == user_a.id, File.deleted_at.is_(None),
    ))
    assert old_row is not None and old_row.size_bytes == 8

    old_path.unlink()
    (root / "new.bin").write_bytes(b"n" * replacement_size)
    second = await run_reconcile("snapshot_diff", "manual")

    assert second.status == "succeeded", second.error_code
    await db.refresh(old_row)
    new_row = await db.scalar(select(File).where(
        File.user_id == user_a.id,
        File.storage_key.endswith("new.bin"),
        File.deleted_at.is_(None),
    ))
    assert old_row.deleted_at is not None
    assert new_row is not None, second.result_counts
    assert new_row.size_bytes == replacement_size
    assert second.result_counts["deleted"] == 1
    assert second.result_counts["created"] == 1


@pytest.mark.asyncio
async def test_reconcile_run_resumes_across_more_than_1800_cumulative_seconds(
    db, user_a, monkeypatch, tmp_path,
):
    """多次短片段累计超过单次预算后仍续跑同一游标并完成，不从头扫描。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "个人文件"
    root.mkdir(parents=True)
    for index in range(183):
        (root / f"note-{index:03}.md").write_text(f"synthetic {index}", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(
            enabled=True, reconcile_timeout_seconds=1800,
            reconcile_slice_seconds=10, reconcile_scan_batch_size=1,
            reconcile_batch_size=200, reconcile_hash_chunk_bytes=1_048_576,
            reconcile_hash_concurrency=1, reconcile_write_concurrency=1,
            compensation_interval_seconds=86_400,
        ),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, targeted, snapshots):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    class LogicalClock:
        def __init__(self):
            import time as real_time

            self.value = real_time.monotonic()

        def monotonic(self):
            return self.value

        def advance(self, seconds):
            self.value += seconds

    logical_clock = LogicalClock()
    monkeypatch.setattr(jobs, "time", logical_clock)
    original_scan = jobs.scan_binding_tree

    def scan_one_budgeted_slice(*args, **kwargs):
        result = original_scan(*args, **kwargs)
        logical_clock.advance(9.9)
        return result

    monkeypatch.setattr(jobs, "scan_binding_tree", scan_one_budgeted_slice)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path="个人文件",
        root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    queued = await jobs.enqueue_reconcile(
        db, binding, reason="bootstrap", mode="integrity_full",
    )
    await db.commit()

    pauses = 0
    for _ in range(200):
        async with db_session._SessionLocal() as worker_db:
            claimed = await jobs.claim_due_job(worker_db)
        assert claimed is not None
        assert claimed[0] == queued.id
        await jobs._run_claimed(db_session._SessionLocal, *claimed)
        async with db_session._SessionLocal() as state_db:
            run = await state_db.get(FileSyncReconcileRun, queued.id)
            if run.status == "succeeded":
                break
            assert run.status == "paused", (run.status, run.error_code)
            assert run.stage == "paused"
            assert run.progress_current > 0
            assert run.progress_total is None
            assert run.result_counts["scanned"] == run.progress_current
            assert {"hashed", "reused", "rejected"} <= run.result_counts.keys()
            pauses += 1
            run.next_run_at = now_utc() - timedelta(seconds=1)
            await state_db.commit()
    else:
        pytest.fail("任务没有在有界的续跑次数内完成")

    async with db_session._SessionLocal() as verify_db:
        run = await verify_db.get(FileSyncReconcileRun, queued.id)
        from sqlalchemy import func

        projected_count = await verify_db.scalar(
            select(func.count()).select_from(File).where(
                File.user_id == user_a.id, File.deleted_at.is_(None),
            ),
        )
    assert pauses >= 181
    assert run.status == "succeeded", run.error_code
    assert run.cumulative_runtime_seconds > 1800
    assert run.result_counts["created"] == 183
    assert projected_count == 183


@pytest.mark.asyncio
async def test_terminal_job_finish_accounts_for_final_execution_slice(db, user_a, monkeypatch):
    """终态任务也必须累计最后一段运行时间，不能只统计发生过暂停的片段。"""
    from types import SimpleNamespace
    from uuid import uuid4
    import app.db.session as db_session

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()
    token = uuid4()
    run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, mode="snapshot_diff",
        reason="manual", status="running", lease_token=token,
        cumulative_runtime_seconds=12.5,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    monkeypatch.setattr(jobs, "time", SimpleNamespace(monotonic=lambda: 130.0))

    await jobs._finish(
        db_session._SessionLocal, run.id, token,
        status="cancelled", error_code="cancelled", slice_started=100.0,
    )

    await db.refresh(run)
    assert run.status == "cancelled"
    assert run.cumulative_runtime_seconds == 42.5


@pytest.mark.asyncio
async def test_single_execution_budget_exhaustion_is_paused_with_budget_reason(
    db, user_a, monkeypatch, tmp_path,
):
    """单次执行预算到期应保存检查点并显示预算暂停，而非普通时间片让出。"""
    import app.db.session as db_session
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.checkpoint as checkpoint
    import app.services.filesync.protocol as protocol

    storage_root = tmp_path / "users"
    root = storage_root / str(user_a.id) / "export"
    root.mkdir(parents=True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(
            enabled=True, reconcile_timeout_seconds=1800,
            reconcile_slice_seconds=3600, reconcile_scan_batch_size=10,
            reconcile_batch_size=10, reconcile_hash_chunk_bytes=1_048_576,
            reconcile_hash_concurrency=1, reconcile_write_concurrency=1,
            compensation_interval_seconds=86_400,
        ),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
    )
    for module in (jobs, baseline, bindings, checkpoint, protocol):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path="export",
        root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    run = await jobs.enqueue_reconcile(
        db, binding, mode="integrity_full", reason="bootstrap",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claim = await jobs.claim_due_job(worker_db)
    assert claim is not None

    class LogicalClock:
        def __init__(self):
            import time as real_time
            self.value = real_time.monotonic()

        def monotonic(self):
            return self.value

        def advance(self, seconds):
            self.value += seconds

    clock = LogicalClock()
    monkeypatch.setattr(jobs, "time", clock)

    def budget_expired_scan(*_args, **_kwargs):
        clock.advance(1801)
        return jobs.ScanResult(
            {}, False, 0, 0, 0, 0, "slice_expired", {}, {},
        )

    monkeypatch.setattr(jobs, "scan_binding_tree", budget_expired_scan)
    await jobs._run_claimed(db_session._SessionLocal, *claim)

    async with db_session._SessionLocal() as verify_db:
        paused = await verify_db.get(FileSyncReconcileRun, run.id)
    assert paused.status == "paused"
    assert paused.pause_reason == "execution_budget"
    assert paused.cumulative_runtime_seconds >= 1800


@pytest.mark.asyncio
async def test_bidirectional_reconcile_keeps_conflicting_path_and_last_baseline(
    db, user_a, monkeypatch, tmp_path,
):
    """双边修改必须登记冲突、跳过该路径投影并保留其最后成功基线。"""
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    import app.services.filesync.snapshots as snapshots
    import app.services.workspaces as workspaces
    import app.services.filesync.outbox as outbox
    import app.db.session as db_session

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    root = user_root / "workspace"
    root.mkdir(parents=True)
    local_file = root / "note.md"
    local_file.write_text("local edit", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
    )
    for module in (jobs, baseline, bindings, protocol, targeted, snapshots):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path="workspace",
        root_fingerprint=root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    old_entry = ScanEntry(
        relative_path="note.md", object_type="file", size_bytes=8,
        mtime_ns=1, ctime_ns=1, fingerprint="a" * 64,
        fingerprint_version=3_001_048_576,
    )
    generation = baseline.FileSyncBaselineStore(user_a.id, binding.id).stage(
        root_fingerprint=binding.root_fingerprint,
        entries={"note.md": old_entry},
    )
    binding.baseline_generation = generation
    now = now_utc()
    file_row = File(
        user_id=user_a.id, display_name="note", ext="md", space="personal",
        storage_key=f"{user_a.id}/workspace/note.md", storage_backend="local",
        size="10", size_bytes=10, updated_at=now,
    )
    db.add(file_row)
    await db.flush()
    db.add(FileSyncJournal(
        binding_id=binding.id, user_id=user_a.id,
        idempotency_key="remote-baseline", source="file_api", operation="update",
        relative_path="note.md", observed_fingerprint="a" * 64,
        status="synced", updated_at=now - timedelta(days=1),
    ))
    await db.commit()
    await db.refresh(binding)

    queued = await jobs.enqueue_reconcile(
        db, binding, mode="snapshot_diff", reason="manual",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        run = await verify_db.get(FileSyncReconcileRun, queued.id)
        refreshed_file = await verify_db.get(File, file_row.id)
        conflict = await verify_db.scalar(select(FileSyncConflict).where(
            FileSyncConflict.binding_id == binding.id,
            FileSyncConflict.relative_path == "note.md",
            FileSyncConflict.status == "pending",
        ))
        refreshed_binding = await verify_db.get(FileSyncBinding, binding.id)
    published = baseline.FileSyncBaselineStore(user_a.id, binding.id).load(
        refreshed_binding.baseline_generation,
        expected_root_fingerprint=binding.root_fingerprint,
    )
    assert run.status == "succeeded", run.error_code
    assert run.result_counts["conflicts"] == 1
    assert conflict is not None
    assert conflict.local_fingerprint != conflict.remote_fingerprint
    assert refreshed_file.size_bytes == 10
    assert published.entries["note.md"] == old_entry


@pytest.mark.asyncio
async def test_mirror_out_job_copies_file_library_to_bound_directory_without_importing(
    db, user_a, monkeypatch, tmp_path,
):
    """mirror_out 的异步任务只向绑定目录复制，不把本地文件反向导入文件库。"""
    import shutil
    import app.db.session as db_session
    import app.services.filesync.bindings as bindings
    import app.services.storage as storage_module

    storage_root = tmp_path / "users"
    user_root = storage_root / str(user_a.id)
    source = user_root / "projects" / "report.md"
    source.parent.mkdir(parents=True)
    source.write_text("library source", encoding="utf-8")
    root = user_root / "export"
    root.mkdir()
    (root / "already-exported.md").write_text("already at destination", encoding="utf-8")
    settings = SimpleNamespace(
        filesync=SimpleNamespace(compensation_interval_seconds=86_400),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
    )
    monkeypatch.setattr(jobs, "get_settings", lambda: settings)
    monkeypatch.setattr(bindings, "get_settings", lambda: settings)

    class LocalCopyStorage:
        def __init__(self):
            self.copy_calls = []
            self.fail_copy = False

        async def exists(self, key):
            return (storage_root / key).is_file()

        async def copy(self, source_key, destination_key):
            self.copy_calls.append((source_key, destination_key))
            if self.fail_copy:
                raise OSError("synthetic copy failure")
            target = storage_root / destination_key
            target.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(shutil.copy2, storage_root / source_key, target)

    storage = LocalCopyStorage()
    monkeypatch.setattr(storage_module, "get_storage", lambda: storage)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_out",
        status="active", root_path="export", root_fingerprint="b" * 64,
    )
    db.add(binding)
    file_row = File(
        user_id=user_a.id, display_name="report", ext="md", space="personal",
        storage_key=f"{user_a.id}/projects/report.md", storage_backend="local",
        size="13", size_bytes=13,
    )
    db.add(file_row)
    db.add(File(
        user_id=user_a.id, display_name="already-exported", ext="md",
        space="personal", storage_key=f"{user_a.id}/export/already-exported.md",
        storage_backend="local", size="21", size_bytes=21,
    ))
    db.add(File(
        user_id=user_a.id, display_name="missing-source", ext="md",
        space="personal", storage_key=f"{user_a.id}/projects/missing-source.md",
        storage_backend="local", size="0", size_bytes=0,
    ))
    await db.commit()
    await db.refresh(binding)

    preview = await jobs.enqueue_reconcile(
        db, binding, mode="mirror_out", reason="manual", dry_run=True,
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)
    async with db_session._SessionLocal() as verify_db:
        preview_run = await verify_db.get(FileSyncReconcileRun, preview.id)
    assert preview_run.status == "succeeded", preview_run.error_code
    assert preview_run.dry_run is True
    assert preview_run.result_counts["copied"] == 1
    assert storage.copy_calls == []
    assert not (root / "projects" / "report.md").exists()

    queued = await jobs.enqueue_reconcile(
        db, binding, mode="integrity_full", reason="manual",
    )
    await db.commit()
    assert queued.mode == "mirror_out"
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        run = await verify_db.get(FileSyncReconcileRun, queued.id)
        files = (await verify_db.scalars(select(File).where(
            File.user_id == user_a.id,
            File.deleted_at.is_(None),
        ))).all()
    assert run.status == "succeeded", run.error_code
    assert run.result_counts["copied"] == 1
    assert run.result_counts["scanned"] == 3
    assert run.result_counts["rejected"] == 1
    assert run.cumulative_runtime_seconds > 0
    assert (root / "projects" / "report.md").read_text(encoding="utf-8") == "library source"
    assert not (root / "export" / "already-exported.md").exists()
    assert len(storage.copy_calls) == 1

    await db.refresh(binding)
    repeated = await jobs.enqueue_reconcile(
        db, binding, mode="mirror_out", reason="daily",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        repeated_run = await verify_db.get(FileSyncReconcileRun, repeated.id)
    assert repeated_run.status == "succeeded", repeated_run.error_code
    assert repeated_run.result_counts["copied"] == 0
    assert len(storage.copy_calls) == 1

    # 每日任务仍检查目标缺失，避免已导出的文件被外部移除后永久漏修复。
    (root / "projects" / "report.md").unlink()
    await db.refresh(binding)
    repair = await jobs.enqueue_reconcile(
        db, binding, mode="mirror_out", reason="daily",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        repair_run = await verify_db.get(FileSyncReconcileRun, repair.id)
    assert repair_run.status == "succeeded", repair_run.error_code
    assert repair_run.result_counts["copied"] == 1
    assert len(storage.copy_calls) == 2
    assert (root / "projects" / "report.md").read_text(encoding="utf-8") == "library source"
    assert len(files) == 3
    assert all(row.deleted_at is None for row in files)

    async with db_session._SessionLocal() as verify_db:
        exported_binding = await verify_db.get(FileSyncBinding, binding.id)
        previous_watermark = exported_binding.last_reconciled_at
    failed_source = user_root / "projects" / "new-report.md"
    failed_source.write_text("new source", encoding="utf-8")
    db.add(File(
        user_id=user_a.id, display_name="new-report", ext="md", space="personal",
        storage_key=f"{user_a.id}/projects/new-report.md", storage_backend="local",
        size="10", size_bytes=10,
    ))
    await db.commit()
    await db.refresh(binding)
    storage.fail_copy = True
    failed = await jobs.enqueue_reconcile(
        db, binding, mode="mirror_out", reason="daily",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        failed_run = await verify_db.get(FileSyncReconcileRun, failed.id)
        failed_binding = await verify_db.get(FileSyncBinding, binding.id)
    assert failed_run.status == "failed"
    assert failed_binding.last_reconciled_at == previous_watermark

    storage.fail_copy = False
    retry = await jobs.enqueue_reconcile(
        db, binding, mode="mirror_out", reason="manual",
    )
    await db.commit()
    async with db_session._SessionLocal() as worker_db:
        claimed = await jobs.claim_due_job(worker_db)
    assert claimed is not None
    await jobs._run_claimed(db_session._SessionLocal, *claimed)

    async with db_session._SessionLocal() as verify_db:
        retry_run = await verify_db.get(FileSyncReconcileRun, retry.id)
    assert retry_run.status == "succeeded", retry_run.error_code
    assert retry_run.result_counts["copied"] == 1
    assert len(storage.copy_calls) == 4
    assert (root / "projects" / "new-report.md").read_text(encoding="utf-8") == "new source"


@pytest.mark.asyncio
async def test_mirror_out_file_library_change_queues_export_without_path_overlap(
    db, user_a, monkeypatch, tmp_path,
):
    """文件库事件应触发 mirror_out，即使源路径不在输出绑定目录下。"""
    import app.services.filesync.protocol as protocol

    storage_root = tmp_path / "users"
    monkeypatch.setattr(protocol, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
    ))
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_out",
        status="active", root_path="export", root_fingerprint="c" * 64,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    await protocol.record_canonical_file_change(
        db, user_id=user_a.id,
        storage_key=f"{user_a.id}/projects/report.md",
        observed_fingerprint="d" * 64,
    )
    await db.commit()

    queued = (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
        FileSyncReconcileRun.status == "queued",
    ))).one()
    assert queued.mode == "mirror_out"
    assert queued.reason == "file_event"
    assert binding.dirty_revision == 1


@pytest.mark.asyncio
async def test_mirror_out_change_during_run_is_queued_after_success(
    db, user_a, monkeypatch,
):
    """claim 固定源水位后到达的文件库变更必须形成下一轮。"""
    import app.db.session as db_session

    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(compensation_interval_seconds=86_400),
    ))
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_out",
        status="active", root_path="export", root_fingerprint="e" * 64,
        dirty_revision=1, baseline_dirty_revision=0,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    run = await jobs.enqueue_reconcile(
        db, binding, mode="mirror_out", reason="file_event",
    )
    await db.commit()

    # enqueue 与 claim 之间已有事件：claim 应把固定截止与脏水位一起取样。
    async with db_session._SessionLocal() as event_db:
        pending_binding = await event_db.get(FileSyncBinding, binding.id)
        pending_binding.dirty_revision = 2
        await event_db.commit()
    async with db_session._SessionLocal() as worker_db:
        claim = await jobs.claim_due_job(worker_db)
    assert claim is not None
    token = claim[1]
    async with db_session._SessionLocal() as verify_db:
        claimed_run = await verify_db.get(FileSyncReconcileRun, run.id)
        assert claimed_run.dirty_revision == 2

    # 固定 cutoff 之后的事件则必须在本轮成功后续排。
    async with db_session._SessionLocal() as event_db:
        active_binding = await event_db.get(FileSyncBinding, binding.id)
        active_binding.dirty_revision = 3
        await event_db.commit()
    await jobs._finish(
        db_session._SessionLocal, run.id, token,
        status="succeeded", counts={"copied": 1},
    )

    async with db_session._SessionLocal() as verify_db:
        finished = await verify_db.get(FileSyncReconcileRun, run.id)
        followup = (await verify_db.scalars(select(FileSyncReconcileRun).where(
            FileSyncReconcileRun.binding_id == binding.id,
            FileSyncReconcileRun.status == "queued",
        ))).one()
        persisted_binding = await verify_db.get(FileSyncBinding, binding.id)
    assert finished.status == "succeeded"
    assert followup.mode == "mirror_out"
    assert followup.reason == "file_event"
    assert followup.dirty_revision == 3
    assert persisted_binding.baseline_dirty_revision == 2


@pytest.mark.asyncio
async def test_binding_direction_change_interrupts_old_run_and_enqueues_new_direction(
    db, user_a,
):
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="bidirectional",
        status="active", root_path="workspace", root_fingerprint="f" * 64,
        scope_revision=3,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    old_run = await jobs.enqueue_reconcile(
        db, binding, mode="integrity_full", reason="manual",
    )
    await db.commit()

    binding.mode = "mirror_out"
    binding.scope_revision += 1
    binding.baseline_generation = None
    new_run = await jobs.enqueue_reconcile(
        db, binding, mode="integrity_full", reason="manual",
    )
    await db.commit()
    await db.refresh(old_run)

    assert old_run.status == "interrupted"
    assert old_run.error_code == "binding_changed"
    assert new_run.id != old_run.id
    assert new_run.mode == "mirror_out"
    assert new_run.binding_revision == binding.scope_revision


@pytest.mark.asyncio
async def test_binding_scope_change_advances_scope_revision_not_journal_revision(
    db, user_a, monkeypatch, tmp_path,
):
    import app.services.filesync.bindings as bindings

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", mode="mirror_in",
        status="active", root_path="old", root_fingerprint="a" * 64,
        revision=17, scope_revision=4, baseline_generation="old-generation",
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    monkeypatch.setattr(bindings, "_root_fingerprint", lambda _root: "b" * 64)

    updated = await bindings._get_or_create_binding(
        db, user_a.id, root_path="new", root=tmp_path, mode="mirror_out",
    )

    assert updated.scope_revision == 5
    assert updated.revision == 17
    assert updated.baseline_generation is None


async def _delivered(_db, _row):
    return True


@pytest.mark.asyncio
async def test_duplicate_reconcile_requests_merge_without_implicit_full_scan(db, user_a):
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    first = await jobs.enqueue_reconcile(db, binding, mode="snapshot_diff", reason="daily")
    second = await jobs.enqueue_reconcile(db, binding, mode="snapshot_diff", reason="manual")

    assert first.id == second.id
    assert second.mode == "snapshot_diff"
    assert second.reason == "manual"
    assert (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
    ))).all() == [first]


def test_targeted_sha256_fingerprint_is_not_reused_as_v2_baseline(tmp_path):
    """旧 targeted 指纹不得绕过新版本哈希，避免同一 stat 下的内容变化漏检。"""
    from app.services.filesync.scan import FINGERPRINT_VERSION, scan_binding_tree

    previous = ScanEntry(
        relative_path="note.md", object_type="file", size_bytes=4,
        mtime_ns=12, ctime_ns=13, fingerprint="a" * 64,
        fingerprint_version=1,
    )
    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    (root / "note.md").write_text("same", encoding="utf-8")
    current = scan_binding_tree(root, user_root=user_root, previous={"note.md": previous})

    assert previous.fingerprint_version != FINGERPRINT_VERSION
    assert current.hashed_count == 1
    assert current.entries["note.md"].fingerprint_version == FINGERPRINT_VERSION * 1_000_000_000 + 1_048_576


def test_dirty_journal_paths_force_current_algorithm_hash(tmp_path):
    from app.services.filesync.scan import scan_binding_tree

    user_root = tmp_path / "synthetic-user"
    root = user_root / "workspace"
    root.mkdir(parents=True)
    file_path = root / "note.md"
    file_path.write_text("same", encoding="utf-8")
    first = scan_binding_tree(root, user_root=user_root)

    second = scan_binding_tree(
        root, user_root=user_root, previous=first.entries,
        force_hash_paths={"note.md"},
    )

    assert second.complete
    assert second.hashed_count == 1
    from app.services.filesync.scan import FINGERPRINT_VERSION
    assert second.entries["note.md"].fingerprint_version == FINGERPRINT_VERSION * 1_000_000_000 + 1_048_576
