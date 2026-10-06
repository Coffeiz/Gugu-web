"""文件 watcher 的实时路径与整树补偿边界。"""
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


async def test_watcher_retains_fallback_signal_while_background_reconcile_is_paused(
    db, user_a, monkeypatch,
):
    """暂停整树回退时保留信号，避免丢失补偿请求或误报活动统计可靠。"""
    from types import SimpleNamespace

    import app.services.filesync.watcher as watcher

    enabled = False
    real_set_activity_reliability = watcher.set_activity_reliability
    real_enqueue_reconcile = watcher.enqueue_reconcile
    monkeypatch.setattr(watcher, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(background_reconcile_enabled=enabled),
    ))
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active",
        root_path="个人文件", root_fingerprint="synthetic-root",
    )
    db.add(binding)
    await db.commit()
    manager = watcher.FileSyncWatcherManager(sidecar=object())
    pending = {binding.id}
    current = {binding.id: (binding, None)}

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("后台对账暂停时不应更新调度水位或排队回退任务")

    monkeypatch.setattr(watcher, "set_activity_reliability", forbidden)
    monkeypatch.setattr(watcher, "enqueue_reconcile", forbidden)

    await manager._enqueue_pending_fallbacks(db, pending, current)

    assert pending == {binding.id}
    assert manager._pending_fallback == set()
    assert (await db.scalars(select(FileSyncReconcileRun))).all() == []

    enabled = True
    monkeypatch.setattr(watcher, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(background_reconcile_enabled=enabled),
    ))
    monkeypatch.setattr(watcher, "set_activity_reliability", real_set_activity_reliability)
    monkeypatch.setattr(watcher, "enqueue_reconcile", real_enqueue_reconcile)
    await manager._enqueue_pending_fallbacks(db, pending, current)

    assert pending == set()
    assert manager._pending_fallback == set()
    resumed_run = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id,
    ))
    assert resumed_run is not None
    assert resumed_run.reason == "event_fallback"
    assert resumed_run.status == "queued"


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


async def test_watcher_fallback_log_hides_exception_path_and_file_content(
    db, user_a, monkeypatch, tmp_path, caplog,
):
    """单点投影故障仍触发整树回退，但普通日志不泄漏异常中的路径或正文。"""
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

    with caplog.at_level(logging.WARNING, logger=watcher.__name__):
        await manager._project_path_events(db, {binding_id: (binding, root)})

    assert manager._pending_fallback == {binding_id}
    assert len(diagnostic_errors) == 1
    assert isinstance(diagnostic_errors[0], OSError)
    assert "OSError" in caplog.text
    assert secret not in caplog.text
    assert "private-file-body" not in caplog.text
