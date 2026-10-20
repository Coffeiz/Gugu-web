"""Linux 内核溢出需进入持久恢复协议，ready 不能擦除该缺口。"""
import os
import sys
from datetime import timedelta
import struct

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="原生 inotify 仅在 Linux 可用")

from app.services.filesync.linux_watcher import NativeWatcher
from app.services.filesync.health import update_binding_health
from app.services.filesync.periodic import enqueue_due_weekly_reconciles
from app.core.tz import now_utc
from app.models import FileSyncBinding, FileSyncReconcileRun
from sqlalchemy import select
from types import SimpleNamespace


def test_native_overflow_emits_reconcile_signal(tmp_path, monkeypatch):
    watcher = NativeWatcher()
    messages = []
    monkeypatch.setattr(watcher, "emit", messages.append)
    data = iter([struct.pack("iIII", -1, 0x4000, 0, 0)])
    original_read = os.read
    def read(descriptor, size):
        if descriptor != watcher.fd:
            return original_read(descriptor, size)
        try:
            return next(data)
        except StopIteration:
            raise BlockingIOError from None
    monkeypatch.setattr(os, "read", read)
    try:
        watcher.drain()
        assert messages == [{"kind": "event", "event": "needs_reconcile", "code": "kernel_event_queue_overflow"}]
    finally:
        os.close(watcher.fd)


@pytest.mark.asyncio
async def test_overflow_ready_keeps_reason_and_scheduler_allows_verified_deletion(db, user_a, monkeypatch, tmp_path):
    import app.services.filesync.periodic as periodic

    user_a.is_active = True
    user_a.last_active_at = now_utc()
    binding = FileSyncBinding(user_id=user_a.id, source="local_directory", mode="bidirectional",
                              status="active", root_path=".", root_fingerprint="a" * 64)
    db.add(binding)
    await db.commit()
    await update_binding_health(db, binding.id, status="degraded", error_code="kernel_event_queue_overflow", gap_detected=True)
    await update_binding_health(db, binding.id, status="ready")
    await db.refresh(binding)
    assert binding.watcher_status == "degraded"
    assert binding.health_error_code == "kernel_event_queue_overflow"
    assert binding.needs_reconcile
    root = tmp_path / "watched"
    root.mkdir()
    async def binding_root(*args):
        return root
    monkeypatch.setattr("app.services.filesync.watcher._binding_root", binding_root)
    stat = root.stat()
    db.add(FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, action="repair", allow_delete=True,
        status="failed", finished_at=now_utc()-timedelta(hours=2),
        root_fingerprint=binding.root_fingerprint, gap_revision=binding.gap_revision,
        result_counts={"rootDevice": stat.st_dev, "rootInode": stat.st_ino},
    ))
    await db.commit()
    monkeypatch.setattr(periodic, "get_settings", lambda: SimpleNamespace(filesync=SimpleNamespace(enabled=True, active_window_days=7)))
    assert await enqueue_due_weekly_reconciles(db) == 1
    run = await db.scalar(select(FileSyncReconcileRun).where(FileSyncReconcileRun.binding_id == binding.id, FileSyncReconcileRun.status == "queued"))
    assert run.allow_delete


def test_native_tracks_nested_delete_without_following_symlink(tmp_path, monkeypatch):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir(); outside.mkdir()
    (root / "nested").mkdir()
    (root / "nested" / "sample.txt").write_text("样本", encoding="utf-8")
    (root / "linked").symlink_to(outside, target_is_directory=True)
    watcher = NativeWatcher()
    messages = []
    monkeypatch.setattr(watcher, "emit", messages.append)
    try:
        watcher.watch({"binding_id": 1, "root": str(root)})
        while watcher.pending:
            watcher.scan_step()
        assert any(message.get("event") == "ready" for message in messages)
        messages.clear()
        (outside / "private.txt").write_text("范围外", encoding="utf-8")
        (root / "nested" / "sample.txt").unlink()
        watcher.drain()
        changes = [message for message in messages if message.get("event") == "change"]
        assert any(message.get("operation") == "delete" and message.get("relative_path") == "nested/sample.txt" for message in changes)
        assert not any("private" in message.get("relative_path", "") for message in changes)
        (root / "nested").rename(outside / "moved")
        watcher.drain()
        messages.clear()
        (outside / "moved" / "after-move.txt").write_text("已移出", encoding="utf-8")
        watcher.drain()
        assert not any(message.get("event") == "change" for message in messages)
        root.rename(tmp_path / "moved-root")
        watcher.drain()
        assert any(message.get("event") == "error" and message.get("code") == "watcher_root_changed" for message in messages)
        watcher.unwatch(1)
        messages.clear()
        root.mkdir()
        (root / "after.txt").write_text("已解除", encoding="utf-8")
        watcher.drain()
        assert not messages
    finally:
        os.close(watcher.fd)


@pytest.mark.asyncio
@pytest.mark.parametrize("guard_state", ["absent", "replaced", "deferred"])
async def test_periodic_overflow_deletion_requires_original_root_identity(
    db, user_a, monkeypatch, tmp_path, guard_state,
):
    import app.services.filesync.periodic as periodic

    user_a.is_active = True
    user_a.last_active_at = now_utc()
    root = tmp_path / "root"
    root.mkdir()
    stat = root.stat()
    metadata = {} if guard_state == "absent" else {"rootDevice": stat.st_dev, "rootInode": stat.st_ino}
    if guard_state == "replaced":
        root.rename(tmp_path / "previous-root")
        root.mkdir()
    from app.services.filesync.reconcile import _root_fingerprint

    binding = FileSyncBinding(user_id=user_a.id, source="local_directory", mode="bidirectional",
                              status="active", root_path=".", root_fingerprint=_root_fingerprint(root),
                              needs_reconcile=True, gap_revision=1,
                              health_error_code="kernel_event_queue_overflow")
    db.add(binding)
    await db.flush()
    db.add(FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, action="repair", allow_delete=False,
        status="succeeded" if guard_state == "deferred" else "failed",
        finished_at=now_utc()-timedelta(hours=2), root_fingerprint=binding.root_fingerprint,
        gap_revision=1, result_counts=metadata,
    ))
    await db.commit()
    async def binding_root(*args):
        return root
    monkeypatch.setattr("app.services.filesync.watcher._binding_root", binding_root)
    monkeypatch.setattr(periodic, "get_settings", lambda: SimpleNamespace(filesync=SimpleNamespace(enabled=True, active_window_days=7)))
    assert await enqueue_due_weekly_reconciles(db) == 1
    queued = await db.scalar(select(FileSyncReconcileRun).where(
        FileSyncReconcileRun.binding_id == binding.id, FileSyncReconcileRun.status == "queued",
    ))
    assert queued.allow_delete is (guard_state == "deferred")


def test_permission_gap_is_coalesced_but_new_kernel_overflows_remain_visible(monkeypatch):
    watcher = NativeWatcher()
    messages = []
    monkeypatch.setattr(watcher, "emit", messages.append)
    try:
        watcher.event(1, "needs_reconcile", code="watcher_permission_denied")
        watcher.event(1, "needs_reconcile", code="watcher_permission_denied")
        watcher.dispatch(-1, 0x4000, "")
        watcher.dispatch(-1, 0x4000, "")
        assert [item["code"] for item in messages] == [
            "watcher_permission_denied", "kernel_event_queue_overflow", "kernel_event_queue_overflow",
        ]
    finally:
        os.close(watcher.fd)


def test_unexpected_kernel_watch_removal_reports_each_active_binding(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    watcher = NativeWatcher()
    messages = []
    monkeypatch.setattr(watcher, "emit", messages.append)
    try:
        for binding_id in (1, 2):
            watcher.watch({"binding_id": binding_id, "root": str(root)})
        while watcher.pending:
            watcher.scan_step()
        messages.clear()
        descriptor = next(iter(watcher.watches))
        # 直接让内核移除 watch，保留订阅映射，模拟意外失效而非主动 unwatch。
        assert watcher.library.inotify_rm_watch(watcher.fd, descriptor) == 0
        watcher.drain()
        assert {(item["binding_id"], item["event"], item["code"]) for item in messages} == {
            (1, "error", "watcher_watch_lost"), (2, "error", "watcher_watch_lost"),
        }
        assert descriptor not in watcher.watches
        messages.clear()
        for binding_id in (1, 2):
            watcher.unwatch(binding_id)
            watcher.watch({"binding_id": binding_id, "root": str(root)})
        while watcher.pending:
            watcher.scan_step()
        messages.clear()
        (root / "after.txt").write_text("恢复后", encoding="utf-8")
        watcher.drain()
        assert {item["binding_id"] for item in messages if item.get("event") == "change"} == {1, 2}
        messages.clear()
        watcher.unwatch(1)
        watcher.unwatch(2)
        watcher.drain()
        assert messages == []
    finally:
        os.close(watcher.fd)


@pytest.mark.asyncio
async def test_lost_watch_marks_health_gap_and_requests_rebuild(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    from app.services.filesync.watcher import FileSyncWatcherManager

    manager = FileSyncWatcherManager()
    manager._binding_roots[1] = ("synthetic-user", tmp_path, "bidirectional")
    health = AsyncMock()
    monkeypatch.setattr(manager, "_health", health)
    await manager._handle_event({
        "binding_id": 1, "event": "error", "code": "watcher_watch_lost",
    })
    health.assert_awaited_once_with(1, "degraded", code="watcher_watch_lost", gap=True)
    assert 1 in manager._rebuild_bindings
