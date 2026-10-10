"""watcher 权限缺口应修复 ACL 后重建索引并安排安全补偿。"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
import uuid

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
async def test_permission_gap_uses_sandboxd_socket_and_authorized_workspace(
    monkeypatch, tmp_path,
):
    """权限缺口从 watcher 事件经 Unix socket 到达 sandboxd，并只修复该用户根目录。"""
    from agent.sandbox import sandboxd
    from app.services.filesync import watcher

    users_root = tmp_path / "users"
    user_id = str(uuid.uuid4())
    workspace = users_root / user_id / "workspace" / "default"
    workspace.mkdir(parents=True)
    socket_path = Path("/tmp") / f"gugu-test-sandboxd-{uuid.uuid4().hex[:12]}.sock"
    settings = SimpleNamespace(
        storage=SimpleNamespace(local_path=str(users_root)),
        sandbox=SimpleNamespace(
            manager_mode="external", sandboxd_socket=str(socket_path),
            stdio_max_sessions=8, stdio_max_sessions_per_user=4,
        ),
    )
    monkeypatch.setattr(watcher, "get_settings", lambda: settings)
    monkeypatch.setattr(sandboxd, "get_settings", lambda: settings)

    prepared: list[tuple[Path, Path]] = []

    class Executor:
        def __init__(self, root, _settings):
            self.root = Path(root)

        def prepare_filesync_access(self, root):
            prepared.append((self.root, Path(root)))

    monkeypatch.setattr(sandboxd, "DockerSandboxExecutor", Executor)
    server = sandboxd.SandboxdServer(socket_path, users_root)

    # SO_PEERCRED 仅在 Linux 可用；此测试覆盖 watcher/client/server 的线协议，
    # 平台身份验证由 sandboxd 的独立安全边界测试负责。
    monkeypatch.setattr(server, "_validate_peer", lambda _writer: None)

    async def runtime_ready():
        return None

    monkeypatch.setattr(server, "_require_runtime_ready", runtime_ready)
    socket_server = await asyncio.start_unix_server(server.handle, path=socket_path)
    events = []

    class Sidecar:
        async def unwatch(self, binding_id):
            events.append(("unwatch", binding_id))

    manager = watcher.FileSyncWatcherManager(sidecar=Sidecar())
    manager._binding_roots[31] = (user_id, workspace, "bidirectional")
    manager._binding_scopes[31] = None

    async def health(binding_id, status, *, code=None, gap=False):
        events.append(("health", binding_id, status, code, gap))

    async def enqueue(binding_id):
        events.append(("repair", binding_id))

    monkeypatch.setattr(manager, "_health", health)
    monkeypatch.setattr(manager, "_enqueue_gap_repair", enqueue)
    try:
        await manager._handle_event({
            "event": "needs_reconcile", "binding_id": 31,
            "code": "watcher_permission_denied",
        })
    finally:
        socket_server.close()
        await socket_server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert prepared == [(workspace.resolve(), workspace.resolve())]
    assert 31 in manager._rebuild_bindings
    assert ("repair", 31) in events


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
