"""保护 watcher 容量在阈值、档位边界和 Admin 硬上限下的可观察行为。"""
import importlib.util
import json
import os
import socket
import threading
from pathlib import Path

import pytest


HELPER_PATH = Path(__file__).parents[3] / "scripts" / "runtime" / "inotify_limitd.py"
SPEC = importlib.util.spec_from_file_location("gugu_inotify_limitd", HELPER_PATH)
assert SPEC and SPEC.loader
limitd = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(limitd)


def _proc_tree(root: Path, uid: int, watches: int) -> Path:
    process = root / "123"
    (process / "fdinfo").mkdir(parents=True)
    (process / "status").write_text(f"Name:\ttest\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
    (process / "fdinfo" / "7").write_text("\n".join(f"inotify wd:{i:x} ino:1 sdev:1\n" for i in range(watches)))
    return root


def test_auto_expands_one_tier_at_80_percent_and_does_not_expand_below_threshold(tmp_path, monkeypatch):
    proc = _proc_tree(tmp_path / "proc", uid=1001, watches=52_428)
    sysctl = tmp_path / "max_user_watches"
    sysctl.write_text("65536\n")
    monkeypatch.setattr(limitd, "_count_cache", {})

    below = limitd.expand(1001, 1_024_000, automatic=True, proc_root=proc, sysctl_path=sysctl)
    assert below["expanded"] is False
    assert below["reason"] == "below_threshold"
    assert sysctl.read_text() == "65536\n"

    (proc / "123" / "fdinfo" / "7").write_text(
        "\n".join(f"inotify wd:{i:x} ino:1 sdev:1\n" for i in range(52_429)),
    )
    monkeypatch.setattr(limitd, "_count_cache", {})
    expanded = limitd.expand(1001, 1_024_000, automatic=True, proc_root=proc, sysctl_path=sysctl)
    assert expanded["expanded"] is True
    assert expanded["usage"] == 52_429
    assert expanded["previousLimit"] == 65_536
    assert expanded["limit"] == 131_072


@pytest.mark.parametrize(
    ("current", "hard_limit", "expected"),
    [
        (65_536, 1_024_000, 131_072),
        (131_072, 1_024_000, 262_144),
        (262_144, 1_024_000, 524_288),
        (524_288, 1_024_000, 1_024_000),
        (524_288, 600_000, 600_000),
        (1_024_000, 1_024_000, 1_024_000),
    ],
)
def test_manual_expansion_advances_one_tier_and_clamps_to_configured_hard_limit(current, hard_limit, expected):
    assert limitd.next_tier(current, hard_limit) == expected


def test_hard_limit_rejects_values_outside_supported_range():
    for invalid in (0, 65_535, 1_024_001, True, "131072"):
        with pytest.raises(ValueError):
            limitd.next_tier(65_536, invalid)


def test_host_manager_uses_current_admin_config_instead_of_request_limit(tmp_path, monkeypatch):
    config = tmp_path / "config.override.json"
    config.write_text(json.dumps({"filesync": {"watch_hard_limit": 131_072}}), encoding="utf-8")
    monkeypatch.setattr(limitd, "CONFIG_OVERRIDE_PATH", config)
    observed = {}

    def status(uid, hard_limit):
        observed.update(uid=uid, hard_limit=hard_limit)
        return {"hardLimit": hard_limit}

    monkeypatch.setattr(limitd, "snapshot", status)
    result = limitd.dispatch(
        {"operation": "status", "hardLimit": limitd.ABSOLUTE_MAX}, uid=1001,
    )

    assert result["hardLimit"] == 131_072
    assert observed == {"uid": 1001, "hard_limit": 131_072}


def test_host_manager_observes_admin_limit_after_atomic_source_replacement(tmp_path, monkeypatch):
    from app.core import config

    override = tmp_path / "config.override.json"
    policy_dir = tmp_path / "policy"
    policy_dir.mkdir()
    policy_file = policy_dir / "policy.json"
    monkeypatch.setattr(config, "OVERRIDE_FILE", override)
    monkeypatch.setenv("GUGU_INOTIFY_POLICY_DIR", str(policy_dir))

    config.write_override_json(
        {"filesync": {"watch_hard_limit": 131_072}},
        project_inotify_policy=True,
    )
    first_inode = policy_file.stat().st_ino
    monkeypatch.setattr(limitd, "CONFIG_OVERRIDE_PATH", policy_file)
    assert limitd.configured_hard_limit() == 131_072

    config.write_override_json(
        {"filesync": {"watch_hard_limit": 262_144}},
        project_inotify_policy=True,
    )

    assert policy_file.stat().st_ino != first_inode
    assert limitd.configured_hard_limit() == 262_144


def test_host_manager_fails_closed_on_invalid_admin_hard_limit(tmp_path):
    config = tmp_path / "config.override.json"
    config.write_text(json.dumps({"filesync": {"watch_hard_limit": limitd.ABSOLUTE_MAX + 1}}), encoding="utf-8")

    with pytest.raises(ValueError):
        limitd.configured_hard_limit(config, default_limit=limitd.ABSOLUTE_MAX)


def test_host_manager_fails_closed_when_policy_file_is_missing(tmp_path):
    with pytest.raises(ValueError, match="missing inotify policy"):
        limitd.configured_hard_limit(
            tmp_path / "missing-policy.json", default_limit=limitd.ABSOLUTE_MAX,
        )


def test_incomplete_socket_request_times_out_and_server_accepts_next_request(monkeypatch):
    monkeypatch.setattr(limitd, "REQUEST_READ_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(limitd, "dispatch", lambda request, uid: {"uid": uid})
    monkeypatch.setattr(limitd, "peer_uid", lambda request: 1001)
    socket_path = Path("/tmp") / f"gugu-inotify-{os.getpid()}-{threading.get_ident()}.sock"
    server = limitd.Server(str(socket_path), limitd.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(str(socket_path))
            client.sendall(b'{"operation":"status"}')
            timed_out = json.loads(client.recv(4096))
            assert timed_out["ok"] is False

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(str(socket_path))
            client.sendall(b'{"operation":"status"}\n')
            completed = json.loads(client.recv(4096))
            assert completed["ok"] is True, completed
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)
        socket_path.unlink(missing_ok=True)


def test_server_rejects_connections_when_all_worker_slots_are_busy(monkeypatch):
    socket_path = Path("/tmp") / f"gugu-inotify-{os.getpid()}-{threading.get_ident()}.sock"
    server = limitd.Server(str(socket_path), limitd.Handler)
    # Exercise saturation without timing-dependent thread scheduling.
    acquired = [limitd._connection_slots.acquire(blocking=False) for _ in range(limitd.MAX_CONNECTIONS)]
    assert all(acquired)
    closed = []
    monkeypatch.setattr(server, "shutdown_request", closed.append)
    try:
        request = object()
        server.process_request(request, None)
        assert closed == [request]
    finally:
        for _ in acquired:
            limitd._connection_slots.release()
        server.server_close()
        socket_path.unlink(missing_ok=True)


def test_admin_hard_limit_cannot_be_lowered_below_current_watch_usage():
    from app.services.filesync.inotify_limit_client import validate_hard_limit_for_usage

    assert validate_hard_limit_for_usage(65_536, 65_536) == 65_536
    with pytest.raises(ValueError, match="不能低于"):
        validate_hard_limit_for_usage(65_535 + 1, 65_537)


@pytest.mark.asyncio
async def test_admin_manual_expansion_uses_one_tier_and_reports_host_manager_unavailable(monkeypatch):
    from types import SimpleNamespace

    from fastapi import HTTPException

    import app.api.v1.filesync_admin as admin
    from app.services.filesync.inotify_limit_client import InotifyLimitUnavailable

    monkeypatch.setattr(admin, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(watch_hard_limit=1_024_000),
    ))
    async def expanded(_operation):
        return {"ok": True, "expanded": True, "limit": 131_072}

    monkeypatch.setattr(admin, "request_limit_agent", expanded)
    assert await admin.expand_watcher_capacity() == {
        "ok": True, "expanded": True, "limit": 131_072,
    }

    async def unavailable(_operation):
        raise InotifyLimitUnavailable("offline")

    monkeypatch.setattr(admin, "request_limit_agent", unavailable)
    with pytest.raises(HTTPException) as exc:
        await admin.expand_watcher_capacity()
    assert exc.value.status_code == 503


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("result", "observed_limit"),
    [
        ({"expanded": True, "limit": 131_072}, None),
        ({"expanded": False, "limit": 262_144}, 131_072),
    ],
)
async def test_capacity_growth_releases_watcher_retry_circuit_breaker(
    monkeypatch, result, observed_limit,
):
    from types import SimpleNamespace

    import app.services.filesync.watcher as watcher_module
    from app.services.filesync.watcher import FileSyncWatcherManager

    async def expanded(_operation):
        return result

    monkeypatch.setattr(watcher_module, "request_limit_agent", expanded)
    monkeypatch.setattr(watcher_module, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(watch_hard_limit=1_024_000),
    ))
    manager = FileSyncWatcherManager(sidecar=SimpleNamespace())
    manager._watcher_limit_seen = observed_limit
    manager._binding_roots[7] = ("user", Path("/synthetic"), "bidirectional")
    manager._rebuild_bindings.add(7)
    manager._rebuild_attempts[7] = manager.MAX_PATH_RETRIES

    await manager._expand_watcher_capacity_if_needed()

    assert 7 in manager._rebuild_bindings
    assert 7 not in manager._rebuild_attempts


@pytest.mark.asyncio
async def test_admin_config_refuses_limit_below_live_watcher_usage(monkeypatch):
    from types import SimpleNamespace

    from fastapi import HTTPException
    import app.api.v1.config as config_api

    class FileSyncConfig:
        watch_hard_limit = 1_024_000

        def model_dump(self):
            return {"watch_hard_limit": self.watch_hard_limit}

    settings = SimpleNamespace(filesync=FileSyncConfig(), storage=SimpleNamespace(backend="local"))
    monkeypatch.setattr(config_api, "get_settings", lambda: settings)

    async def live_capacity(_operation):
        return {"usage": 70_000}

    monkeypatch.setattr(config_api, "request_limit_agent", live_capacity)
    with pytest.raises(HTTPException) as exc:
        await config_api._validate_filesync_patch({"watch_hard_limit": 65_536})

    assert exc.value.status_code == 400
    assert "不能低于" in exc.value.detail
