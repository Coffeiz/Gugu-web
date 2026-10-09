"""保护 watcher 容量在阈值、档位边界和 Admin 硬上限下的可观察行为。"""
import importlib.util
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
    async def expanded(_operation, _hard_limit):
        return {"ok": True, "expanded": True, "limit": 131_072}

    monkeypatch.setattr(admin, "request_limit_agent", expanded)
    assert await admin.expand_watcher_capacity() == {
        "ok": True, "expanded": True, "limit": 131_072,
    }

    async def unavailable(_operation, _hard_limit):
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

    async def expanded(_operation, _hard_limit):
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

    async def live_capacity(_operation, _hard_limit):
        return {"usage": 70_000}

    monkeypatch.setattr(config_api, "request_limit_agent", live_capacity)
    with pytest.raises(HTTPException) as exc:
        await config_api._validate_filesync_patch({"watch_hard_limit": 65_536})

    assert exc.value.status_code == 400
    assert "不能低于" in exc.value.detail
