"""文件 watcher 的实时路径、有限重试与手动核对边界。"""
from __future__ import annotations

import os

from sqlalchemy import select

from app.models import (
    File, FileSyncBinding, FileSyncJournal, FileSyncOutbox, FileSyncReconcileRun,
)
from app.services.filesync.protocol import (
    FileSyncOperation, FileSyncSource, FileSyncStatus, build_idempotency_key,
    record_change,
)


async def test_watcher_projects_path_event_without_queueing_reconcile_job(
    db, user_a, monkeypatch, tmp_path,
):
    """普通实时路径事件直接走 targeted 投影，不受整树持久任务队列影响。"""
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted
    import app.services.filesync.watcher as watcher

    settings = type("Settings", (), {
        "filesync": type("FileSyncSettings", (), {
            "enabled": True, "background_reconcile_enabled": False,
        })(),
        "storage": type("StorageSettings", (), {
            "backend": "local", "local_path": str(tmp_path),
        })(),
    })()
    for module in (protocol, targeted, watcher):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "realtime.txt"
    path.write_text("及时投影", encoding="utf-8")
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="test-root",
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)

    class OnePathEvent:
        def __init__(self):
            self.sent = False

        async def next_event(self):
            if self.sent:
                return None
            self.sent = True
            return {
                "event": "change", "binding_id": binding.id,
                "relative_path": "realtime.txt", "operation": "create",
                "object_type": "file",
            }

    manager = watcher.FileSyncWatcherManager(sidecar=OnePathEvent())
    await manager._drain_events(set(), {binding.id})
    await manager._project_path_events(db, {binding.id: (binding, root)})

    projected = await db.scalar(select(File).where(
        File.user_id == user_a.id,
        File.storage_key == f"{user_a.id}/个人文件/realtime.txt",
        File.deleted_at.is_(None),
    ))
    event = await db.scalar(select(FileSyncOutbox).where(
        FileSyncOutbox.user_id == user_a.id,
        FileSyncOutbox.source == "local_directory",
    ))
    jobs = (await db.scalars(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
    ))).all()
    assert projected is not None
    assert event is not None
    assert jobs == []


async def test_watcher_health_events_update_status_without_erasing_gap(db, user_a):
    """ready 恢复监听健康；error 持久化新缺口，且 ready 不掩盖它。"""
    import app.services.filesync.watcher as watcher

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="synthetic-root",
        watcher_status="degraded", health_error_code="watcher_error",
        needs_reconcile=True, gap_revision=2,
    )
    db.add(binding)
    await db.commit()

    class HealthEvents:
        def __init__(self):
            self.events = iter((
                {"event": "ready", "binding_id": binding.id},
                {"event": "error", "binding_id": binding.id, "code": "watcher_limit_exceeded"},
                {"event": "ready", "binding_id": binding.id},
            ))

        async def next_event(self):
            return next(self.events, None)

    pending = set()
    manager = watcher.FileSyncWatcherManager(sidecar=HealthEvents())
    await manager._drain_events(pending, {binding.id}, db=db)
    await db.refresh(binding)

    assert binding.watcher_status == "ready"
    assert binding.health_error_code is None
    assert binding.needs_reconcile is True
    assert binding.gap_revision == 3
    assert pending == {binding.id}


async def test_watcher_health_gap_does_not_enqueue_automatic_reconcile(db, user_a):
    """监听缺口只持久标记为需手动核对，不排入依赖基线的整树任务。"""
    import app.services.filesync.watcher as watcher

    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="synthetic-root",
    )
    db.add(binding)
    await db.commit()
    manager = watcher.FileSyncWatcherManager(sidecar=object())
    pending: set[int] = set()

    class HealthEvents:
        def __init__(self):
            self.events = iter(({
                "event": "error", "binding_id": binding.id,
                "code": "python_event_queue_overflow",
            },))

        async def next_event(self):
            return next(self.events, None)

    manager._sidecar = HealthEvents()
    await manager._drain_events(pending, {binding.id}, db)

    await db.refresh(binding)
    assert pending == {binding.id}
    assert binding.needs_reconcile is True
    assert binding.health_error_code == "python_event_queue_overflow"
    assert (await db.scalars(select(FileSyncReconcileRun))).all() == []


async def test_path_event_batch_merge_keeps_newest_operation_per_path():
    """失败重试与新事件合并时，同一路径保留时间较新的操作。"""
    from app.services.filesync.targeted import PathEventBatch

    pending = PathEventBatch(
        changed={"update-then-delete.txt", "delete-then-update.txt"},
        deleted={"stale-delete.txt"},
        folders_created={"create-then-delete"},
    )
    newer = PathEventBatch(
        deleted={"update-then-delete.txt"},
        changed={"delete-then-update.txt"},
        folders_deleted={"create-then-delete"},
    )

    pending.merge(newer)

    assert pending.changed == {"delete-then-update.txt"}
    assert pending.deleted == {"stale-delete.txt", "update-then-delete.txt"}
    assert pending.folders_created == set()
    assert pending.folders_deleted == {"create-then-delete"}


async def test_watcher_retries_transient_targeted_failure_without_reconcile_job(
    db, user_a, monkeypatch, tmp_path,
):
    """瞬时投影错误恢复后继续按精确路径完成，不依赖基线或整树任务。"""
    import app.services.filesync.watcher as watcher
    from app.services.filesync.summary import SyncSummary
    from unittest.mock import AsyncMock

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="test-root",
        watcher_status="ready", needs_reconcile=False,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    binding_id = binding.id
    project = AsyncMock(side_effect=(OSError("transient database failure"), SyncSummary()))
    monkeypatch.setattr(watcher, "project_path_events", project)
    manager = watcher.FileSyncWatcherManager(sidecar=object())
    manager._path_events[binding_id] = watcher.PathEventBatch(changed={"note.txt"})
    pending: set[int] = set()
    current = {binding_id: (binding, root)}

    await manager._project_path_events(db, current, pending)
    assert binding_id in manager._path_events
    assert manager._path_event_retries[binding_id] == 1

    await manager._project_path_events(db, current, pending)

    assert project.await_count == 2
    assert manager._path_events == {}
    assert manager._path_event_retries == {}
    assert pending == set()
    assert (await db.scalars(select(FileSyncReconcileRun))).all() == []


async def test_targeted_event_rehashes_content_when_size_and_mtime_are_unchanged(
    db, user_a, monkeypatch, tmp_path,
):
    """实时 dirty-path 必须重算正文指纹，避免旧 stat 缓存吞掉等长覆盖写。"""
    from types import SimpleNamespace

    import app.services.filesync.protocol as protocol
    import app.services.filesync.targeted as targeted

    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True),
        storage=SimpleNamespace(backend="local", local_path=str(tmp_path)),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000),
    )
    for module in (protocol, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    path = root / "note.txt"
    path.write_bytes(b"aaaa")
    old_fingerprint = targeted._stable_fingerprint(path)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        mode="bidirectional", root_path="个人文件",
        root_fingerprint="test-root",
    )
    row = File(
        user_id=user_a.id, display_name="note", ext="txt", space="personal",
        storage_key=f"{user_a.id}/个人文件/note.txt", storage_backend="local",
        size="4", size_bytes=4,
    )
    db.add_all([binding, row])
    await db.flush()
    await record_change(
        db, binding=binding, user_id=user_a.id,
        source=FileSyncSource.LOCAL_DIRECTORY, operation=FileSyncOperation.CREATE,
        relative_path="note.txt",
        idempotency_key=build_idempotency_key(
            source=FileSyncSource.LOCAL_DIRECTORY, operation=FileSyncOperation.CREATE,
            relative_path="note.txt", fingerprint=old_fingerprint,
        ),
        observed_fingerprint=old_fingerprint, status=FileSyncStatus.SYNCED,
    )
    await db.commit()

    # 即使 size/mtime 未变，精确 dirty-path 也必须重算正文指纹。
    old_stat = path.stat()
    path.write_bytes(b"bbbb")
    os.utime(path, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
    assert path.stat().st_size == old_stat.st_size
    assert path.stat().st_mtime_ns == old_stat.st_mtime_ns

    result = await targeted.project_path_events(
        db, user_a.id, binding, root, targeted.PathEventBatch(changed={"note.txt"}),
    )
    await db.commit()

    await db.refresh(row)
    journals = (await db.scalars(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.relative_path == "note.txt",
        FileSyncJournal.status == FileSyncStatus.SYNCED,
    ).order_by(FileSyncJournal.id))).all()
    assert result.updated == 1
    assert row.version == 2
    assert journals[-1].observed_fingerprint != old_fingerprint


async def test_watcher_retry_log_hides_exception_path_and_file_content(
    db, user_a, monkeypatch, tmp_path, caplog,
):
    """精确路径重试日志不泄漏异常中的路径或正文。"""
    import logging

    import app.services.filesync.watcher as watcher

    root = tmp_path / str(user_a.id) / "个人文件"
    root.mkdir(parents=True)
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="test-root",
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    binding_id = binding.id

    secret = "/Users/synthetic/private-note.txt private-file-body"
    diagnostic_errors = []

    async def fail_projection(*_args, **_kwargs):
        raise OSError(secret)

    monkeypatch.setattr(watcher, "project_path_events", fail_projection)
    monkeypatch.setattr(
        watcher, "diag_log", lambda _where, exc: diagnostic_errors.append(exc),
    )
    manager = watcher.FileSyncWatcherManager(sidecar=object())
    manager._path_events[binding_id] = watcher.PathEventBatch(changed={"note.txt"})

    pending: set[int] = set()
    with caplog.at_level(logging.WARNING, logger=watcher.__name__):
        for _ in range(watcher.MAX_TARGETED_PATH_RETRIES + 1):
            await manager._project_path_events(
                db, {binding_id: (binding, root)}, pending,
            )

    assert binding_id in pending
    assert manager._path_events == {}
    assert len(diagnostic_errors) == watcher.MAX_TARGETED_PATH_RETRIES + 1
    assert isinstance(diagnostic_errors[0], OSError)
    assert "重试耗尽，需手动核对" in caplog.text
    assert secret not in caplog.text
    assert "private-file-body" not in caplog.text
    assert (await db.scalars(select(FileSyncReconcileRun))).all() == []
