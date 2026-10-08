"""watcher 权限缺口应修复 ACL 后重建索引并安排安全补偿。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_permission_gap_repairs_workspace_then_rebuilds_watcher(monkeypatch, tmp_path):
    from app.services.filesync import watcher

    root = tmp_path / "workspace"
    root.mkdir()
    actions: list[tuple] = []

    class Sidecar:
        async def unwatch(self, binding_id):
            actions.append(("unwatch", binding_id))

    manager = watcher.FileSyncWatcherManager(sidecar=Sidecar())
    manager._binding_roots[17] = ("synthetic-user", root, "bidirectional")
    manager._binding_scopes[17] = None

    async def prepare(workspace_root):
        actions.append(("prepare", workspace_root))
        return True

    async def health(binding_id, status, *, code=None, gap=False):
        actions.append(("health", binding_id, status, code, gap))

    async def enqueue(binding_id):
        actions.append(("repair", binding_id))

    monkeypatch.setattr(watcher, "get_settings", lambda: SimpleNamespace(
        sandbox=SimpleNamespace(manager_mode="embedded"),
    ))
    monkeypatch.setattr(manager, "_prepare_filesync_access", prepare)
    monkeypatch.setattr(manager, "_health", health)
    monkeypatch.setattr(manager, "_enqueue_gap_repair", enqueue)

    await manager._handle_event({
        "event": "needs_reconcile", "binding_id": 17, "code": "watcher_permission_denied",
    })

    assert ("prepare", root) in actions
    assert ("unwatch", 17) in actions
    assert 17 in manager._rebuild_bindings
    assert ("repair", 17) in actions


@pytest.mark.asyncio
@pytest.mark.parametrize("exhausted", [False, True])
async def test_unrepaired_permission_gap_remains_visible_and_requests_reconcile(
    monkeypatch, tmp_path, exhausted,
):
    from app.services.filesync import watcher

    class Sidecar:
        async def unwatch(self, _binding_id):
            pass

    manager = watcher.FileSyncWatcherManager(sidecar=Sidecar())
    manager._binding_roots[17] = ("synthetic-user", tmp_path, "bidirectional")
    if exhausted:
        manager._rebuild_attempts[17] = manager.MAX_PATH_RETRIES
    outcomes = []
    repairs = []
    attempts = []

    async def prepare(_root):
        attempts.append(True)
        raise watcher.SandboxdUnavailable("合成权限失败")

    async def health(_binding_id, status, *, code=None, gap=False):
        outcomes.append((status, code, gap))

    async def enqueue(binding_id):
        repairs.append(binding_id)

    monkeypatch.setattr(watcher, "get_settings", lambda: SimpleNamespace(
        sandbox=SimpleNamespace(manager_mode="external"),
    ))
    monkeypatch.setattr(manager, "_prepare_filesync_access", prepare)
    monkeypatch.setattr(manager, "_health", health)
    monkeypatch.setattr(manager, "_enqueue_gap_repair", enqueue)
    await manager._handle_event({
        "event": "needs_reconcile", "binding_id": 17, "code": "watcher_permission_denied",
    })
    assert attempts == ([] if exhausted else [True])
    assert outcomes == [("degraded", "watcher_permission_denied" if exhausted
                         else "workspace_permission_repair_failed", True)]
    assert repairs == [17]
