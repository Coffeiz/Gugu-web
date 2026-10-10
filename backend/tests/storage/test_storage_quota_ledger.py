import asyncio
from datetime import datetime, timezone
from threading import Event, Timer
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import File, StorageQuotaEvent, StorageQuotaLedger, WorkspaceDirectory
from app.services.storage import quota_ledger
from app.services.storage.quota_limits import UNLIMITED_BYTES, resolve_file_library_limit


@pytest.mark.parametrize(
    ("user_limit", "global_limit", "expected"),
    [
        (None, None, UNLIMITED_BYTES),
        (None, 4096, 4096),
        (0, 4096, 0),
        (1024, 4096, 1024),
    ],
)
def test_file_library_limit_uses_none_not_truthiness(user_limit, global_limit, expected):
    assert resolve_file_library_limit(user_limit, global_limit) == expected


@pytest.mark.asyncio
async def test_local_download_budget_includes_workspace_shell_usage_and_preserves_zero_limit(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    db.add_all([
        File(user_id=user_a.id, display_name="存活", ext="bin", storage_key="live", size_bytes=30),
        File(user_id=user_a.id, display_name="回收", ext="bin", storage_key="deleted", size_bytes=90,
             deleted_at=datetime.now(timezone.utc)),
    ])
    user_a.storage_limit_bytes = 100
    await db.flush()
    shell_root = tmp_path / str(user_a.id) / "workspace" / "default"
    shell_root.mkdir(parents=True)
    (shell_root / "output.bin").write_bytes(b"x" * 5)

    assert await quota_ledger.get_file_library_download_budget(db, user_a.id, 500) == (100, 65)
    user_a.storage_limit_bytes = 0
    await db.flush()
    assert await quota_ledger.get_file_library_download_budget(db, user_a.id, 500) == (0, 0)


@pytest.mark.asyncio
async def test_admin_file_record_usage_sums_live_rows_per_owner(db, user_a, user_b):
    db.add_all([
        File(user_id=user_a.id, display_name="第一份", ext="bin", storage_key="a-1", size_bytes=30),
        File(user_id=user_a.id, display_name="第二份", ext="bin", storage_key="a-2", size_bytes=12),
        File(user_id=user_a.id, display_name="已删除", ext="bin", storage_key="a-3", size_bytes=90,
             deleted_at=datetime.now(timezone.utc)),
        File(user_id=user_b.id, display_name="他人文件", ext="bin", storage_key="b-1", size_bytes=7),
    ])
    await db.flush()

    usage = await quota_ledger.get_file_record_usage_by_user(db)

    assert usage == {str(user_a.id): 42, str(user_b.id): 7}


def _settings(tmp_path):
    return SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path), backend="local"),
        quota=SimpleNamespace(default_storage_limit_bytes=None),
        sandbox=SimpleNamespace(
            persistent_quota_bytes=512,
            ephemeral_quota_bytes=1024,
        ),
    )


@pytest.mark.asyncio
async def test_user_space_initialization_is_idempotent(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))

    first = await quota_ledger.ensure_user_storage_space(db, user_a)
    second = await quota_ledger.ensure_user_storage_space(db, user_a)
    await db.commit()

    assert (tmp_path / str(user_a.id) / "workspace").is_dir()
    assert {row.category for row in first} == {
        quota_ledger.FILE_LIBRARY,
        quota_ledger.SHELL_PERSISTENT,
        quota_ledger.SHELL_EPHEMERAL,
    }
    assert len(second) == 3
    events = (await db.execute(
        select(StorageQuotaEvent).where(StorageQuotaEvent.user_id == user_a.id)
    )).scalars().all()
    assert len(events) == 3


@pytest.mark.asyncio
async def test_existing_user_ledgers_refresh_limits_without_scanning_directories(
    db, user_a, tmp_path, monkeypatch,
):
    """账本已齐全时重启回填只更新配置，不重复递归测量用户目录。"""
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    rows = await quota_ledger.ensure_user_storage_space(db, user_a)
    rows_by_category = {row.category: row for row in rows}
    rows_by_category[quota_ledger.FILE_LIBRARY].used_bytes = 37
    rows_by_category[quota_ledger.SHELL_EPHEMERAL].used_bytes = 5
    user_a.storage_limit_bytes = 8192
    await db.flush()

    async def unexpected_scan(*_args, **_kwargs):
        raise AssertionError("已初始化账本不应触发递归目录扫描")

    monkeypatch.setattr(quota_ledger, "_measure_local_unregistered_bytes", unexpected_scan)
    monkeypatch.setattr(quota_ledger, "_unregistered_shell_bytes", unexpected_scan)

    refreshed = await quota_ledger.ensure_user_storage_space(db, user_a)
    refreshed_by_category = {row.category: row for row in refreshed}

    assert refreshed_by_category[quota_ledger.FILE_LIBRARY].limit_bytes == 8192
    assert refreshed_by_category[quota_ledger.FILE_LIBRARY].used_bytes == 37
    assert refreshed_by_category[quota_ledger.SHELL_PERSISTENT].root_path == str(
        tmp_path / str(user_a.id) / "workspace"
    )
    assert refreshed_by_category[quota_ledger.SHELL_EPHEMERAL].used_bytes == 5


@pytest.mark.asyncio
async def test_usage_event_is_idempotent_and_rejects_over_quota(db, user_a, tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    settings.storage.backend = "oss"
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: settings)
    await quota_ledger.ensure_user_storage_space(db, user_a)

    await quota_ledger.record_usage(
        db, user_a.id, category=quota_ledger.SHELL_PERSISTENT,
        delta_bytes=100, operation="build", idempotency_key="build-1",
    )
    await quota_ledger.record_usage(
        db, user_a.id, category=quota_ledger.SHELL_PERSISTENT,
        delta_bytes=100, operation="build", idempotency_key="build-1",
    )
    row = await quota_ledger.get_quota(db, user_a.id, quota_ledger.SHELL_PERSISTENT)
    assert row.used_bytes == 100

    with pytest.raises(ValueError, match="存储空间已满"):
        await quota_ledger.record_usage(
            db, user_a.id, category=quota_ledger.SHELL_PERSISTENT,
            delta_bytes=413, operation="shell_exec", idempotency_key="shell-1",
        )


@pytest.mark.asyncio
async def test_reconcile_records_actual_file_and_shell_usage(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    root = tmp_path / str(user_a.id) / "workspace"
    root.mkdir(parents=True)
    (root / "artifact.bin").write_bytes(b"1234")
    result = await quota_ledger.verify_user_storage_space(db, user_a.id)
    await db.commit()

    assert result["root_exists"] is True
    assert result["measured"][quota_ledger.SHELL_PERSISTENT] == 4
    assert result["categories"][quota_ledger.SHELL_PERSISTENT]["used_bytes"] == 4
    row = (await db.execute(
        select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_a.id,
            StorageQuotaLedger.category == quota_ledger.SHELL_PERSISTENT,
        )
    )).scalar_one()
    assert row.last_reconciled_at is not None


@pytest.mark.asyncio
async def test_slow_quota_directory_measurement_does_not_block_event_loop(
    db, user_a, tmp_path, monkeypatch,
):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    root = tmp_path / str(user_a.id) / "workspace"
    root.mkdir(parents=True)
    scan_started = Event()
    release_scan = Event()

    def slow_measure(_path, *, stop_event):
        scan_started.set()
        while not stop_event.is_set() and not release_scan.wait(0.01):
            pass
        if stop_event.is_set():
            raise InterruptedError("配额测量已取消")
        return 0

    monkeypatch.setattr(quota_ledger, "measure_directory", slow_measure)
    scan = asyncio.create_task(quota_ledger._measure_local_unregistered_bytes(db, user_a.id))
    release_timer = Timer(0.25, release_scan.set)
    release_timer.start()
    try:
        assert await asyncio.to_thread(scan_started.wait, 1)
        loop_pulse = asyncio.Event()
        asyncio.get_running_loop().call_later(0.05, loop_pulse.set)
        await asyncio.wait_for(loop_pulse.wait(), timeout=0.15)
    finally:
        release_scan.set()
        release_timer.cancel()
    assert await scan == ({"workspace": 0, "personal": 0, "project": 0}, {
        "workspace": 0, "personal": 0, "project": 0,
    })


@pytest.mark.asyncio
async def test_cancelled_quota_measurement_stops_its_worker_scan(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    (tmp_path / str(user_a.id) / "workspace").mkdir(parents=True)
    scan_started = Event()

    def cancellable_measure(_path, *, stop_event):
        scan_started.set()
        while not stop_event.wait(0.01):
            pass
        raise InterruptedError("配额测量已取消")

    monkeypatch.setattr(quota_ledger, "measure_directory", cancellable_measure)
    scan = asyncio.create_task(quota_ledger._measure_local_unregistered_bytes(db, user_a.id))
    assert await asyncio.to_thread(scan_started.wait, 1)
    scan.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(scan, timeout=1)


@pytest.mark.asyncio
async def test_file_library_display_uses_ledger_without_scanning_directories(
    db, user_a, tmp_path, monkeypatch,
):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    db.add(StorageQuotaLedger(
        user_id=user_a.id,
        category=quota_ledger.FILE_LIBRARY,
        used_bytes=1234,
        limit_bytes=4096,
    ))
    await db.flush()

    async def fail_if_scanned(*_args, **_kwargs):
        raise AssertionError("文件库展示用量不应遍历物理目录")

    monkeypatch.setattr(quota_ledger, "_measure_local_unregistered_bytes", fail_if_scanned)
    assert await quota_ledger.get_file_library_usage_snapshot(db, user_a.id) == 1234


@pytest.mark.asyncio
async def test_file_library_display_fallback_sums_only_live_file_rows(db, user_a):
    db.add_all([
        File(user_id=user_a.id, display_name="存活", ext="bin", storage_key="live", size_bytes=30),
        File(
            user_id=user_a.id, display_name="回收", ext="bin", storage_key="deleted", size_bytes=90,
            deleted_at=datetime.now(timezone.utc),
        ),
    ])
    await db.flush()

    assert await quota_ledger.get_file_library_usage_snapshot(db, user_a.id) == 30


@pytest.mark.asyncio
async def test_admin_storage_usage_map_uses_only_aggregate_file_library_rows(db, user_a):
    db.add_all([
        StorageQuotaLedger(
            user_id=user_a.id, category=quota_ledger.FILE_LIBRARY,
            used_bytes=1234, limit_bytes=4096,
        ),
        StorageQuotaLedger(
            user_id=user_a.id, category=quota_ledger.SHELL_PERSISTENT,
            used_bytes=234, limit_bytes=4096,
        ),
    ])
    await db.flush()

    assert await quota_ledger.get_file_library_usage_by_user(db) == {str(user_a.id): 1234}


@pytest.mark.asyncio
async def test_storage_quota_measurement_remains_authoritative(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    root = tmp_path / str(user_a.id) / "workspace" / "default"
    root.mkdir(parents=True)
    (root / "unregistered.bin").write_bytes(b"actual")
    db.add(StorageQuotaLedger(
        user_id=user_a.id,
        category=quota_ledger.FILE_LIBRARY,
        used_bytes=1,
        limit_bytes=4096,
    ))
    await db.flush()

    from app.services.files.browser import get_storage_usage

    assert await get_storage_usage(db, user_a.id) == len(b"actual")


@pytest.mark.asyncio
async def test_periodic_reconcile_does_not_overwrite_concurrent_ledger_delta(
    db, user_a, tmp_path, monkeypatch,
):
    from datetime import timedelta

    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    rows = [
        StorageQuotaLedger(
            user_id=user_a.id, category=category, used_bytes=10,
            limit_bytes=4096, status="active",
        )
        for category in (
            quota_ledger.FILE_LIBRARY,
            quota_ledger.SHELL_PERSISTENT,
            quota_ledger.SHELL_EPHEMERAL,
        )
    ]
    db.add_all(rows)
    await db.flush()

    async def update_during_measurement(db_, _user_id):
        row = await db_.scalar(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_a.id,
            StorageQuotaLedger.category == quota_ledger.FILE_LIBRARY,
        ))
        row.used_bytes = 50
        row.updated_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        await db_.flush()
        return {}, {}

    async def no_shell_usage(*_args):
        return 0

    monkeypatch.setattr(quota_ledger, "measure_shell_persistent_usage", no_shell_usage)
    monkeypatch.setattr(quota_ledger, "_measure_local_unregistered_bytes", update_during_measurement)

    await quota_ledger.reconcile_user_storage(
        db, user_a.id, preserve_concurrent_updates=True,
    )
    await db.refresh(rows[0])

    assert rows[0].used_bytes == 50
    assert rows[0].last_reconciled_at is None


@pytest.mark.asyncio
async def test_local_workspace_files_and_shell_writes_share_user_limit(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    user_a.storage_limit_bytes = 100
    storage_key = f"{user_a.id}/workspace/default/registered.bin"
    registered_path = tmp_path / storage_key
    registered_path.parent.mkdir(parents=True)
    registered_path.write_bytes(b"x" * 20)
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="默认", directory_name="default", is_default=True,
    )
    db.add(directory)
    await db.flush()
    db.add(File(
        user_id=user_a.id, display_name="workspace file", ext="bin",
        storage_key=storage_key, size_bytes=20, space="workspace",
        workspace_directory_id=directory.id,
    ))
    shell_root = tmp_path / str(user_a.id) / "workspace"
    (shell_root / "default" / "untracked.bin").write_bytes(b"y" * 10)
    await db.flush()

    measured = await quota_ledger.reconcile_user_storage(db, user_a.id)
    await db.commit()
    total = await quota_ledger.get_quota(db, user_a.id, quota_ledger.FILE_LIBRARY)
    shell = await quota_ledger.get_quota(db, user_a.id, quota_ledger.SHELL_PERSISTENT)
    watch_roots, watch_limit = await quota_ledger.get_local_storage_quota_watch(
        db, user_a.id, include_library=False,
    )

    assert measured[quota_ledger.FILE_LIBRARY] == 30
    assert total.used_bytes == 30
    assert total.limit_bytes == 100
    assert shell.used_bytes == 10
    assert shell.limit_bytes == 2**63 - 1
    assert watch_roots == (shell_root,)
    assert watch_limit == 100

    await quota_ledger.record_usage(
        db, user_a.id, category=quota_ledger.SHELL_PERSISTENT,
        delta_bytes=5, operation="shell_exec", idempotency_key="local-shell-write",
    )
    assert (await quota_ledger.get_quota(db, user_a.id, quota_ledger.FILE_LIBRARY)).used_bytes == 35


@pytest.mark.asyncio
async def test_importing_precounted_physical_file_does_not_double_count_quota(
    db, user_a, tmp_path, monkeypatch,
):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    path = tmp_path / str(user_a.id) / "workspace" / "default" / "imported.bin"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"x" * 23)

    rows = await quota_ledger.ensure_user_storage_space(db, user_a)
    file_quota = next(row for row in rows if row.category == quota_ledger.FILE_LIBRARY)
    baseline = file_quota.used_bytes
    await db.flush()
    db.add(File(
        user_id=user_a.id, display_name="imported", ext="bin",
        storage_key=f"{user_a.id}/workspace/default/imported.bin", size_bytes=23,
        space="workspace",
    ))
    await db.flush()

    measured = await quota_ledger.reconcile_user_storage(db, user_a.id)

    assert measured[quota_ledger.FILE_LIBRARY] == baseline == 23
    assert file_quota.used_bytes == 23


@pytest.mark.asyncio
async def test_full_shell_authorization_watches_all_persistent_user_roots(db, user_a, tmp_path, monkeypatch):
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
    user_a.storage_limit_bytes = 100
    roots = quota_ledger._local_quota_roots(user_a.id)
    (roots["workspace"] / "registered.bin").parent.mkdir(parents=True)
    (roots["workspace"] / "registered.bin").write_bytes(b"w" * 20)
    (roots["workspace"] / "shell.bin").write_bytes(b"s" * 10)
    (roots["personal"] / "registered.bin").parent.mkdir(parents=True)
    (roots["personal"] / "registered.bin").write_bytes(b"p" * 15)
    (roots["personal"] / "shell.bin").write_bytes(b"u" * 5)
    (roots["project"] / "shell.bin").parent.mkdir(parents=True)
    (roots["project"] / "shell.bin").write_bytes(b"v" * 7)
    db.add_all([
        File(user_id=user_a.id, display_name="workspace", ext="bin",
             storage_key=f"{user_a.id}/workspace/registered.bin", size_bytes=20),
        File(user_id=user_a.id, display_name="personal", ext="bin",
             storage_key=f"{user_a.id}/个人文件/registered.bin", size_bytes=15),
    ])
    await db.flush()

    measured = await quota_ledger.measure_user_storage_usage(db, user_a.id)
    watch_roots, watch_limit = await quota_ledger.get_local_storage_quota_watch(
        db, user_a.id, include_library=True,
    )

    assert measured == 57
    assert watch_roots == (roots["workspace"], roots["personal"], roots["project"])
    assert sum(quota_ledger.measure_directory(root) for root in watch_roots) == 57
    assert watch_limit == 100

    # 普通授权只把当前 Shell workspace 纳入 watcher，不把只读个人/项目挂载算入。
    limited_roots, limited_watch_limit = await quota_ledger.get_local_storage_quota_watch(
        db, user_a.id, include_library=False,
    )
    assert limited_roots == (roots["workspace"],)
    assert limited_watch_limit == 73


@pytest.mark.asyncio
async def test_oss_keeps_file_and_shell_persistent_limits_separate(db, user_a, tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    settings.storage.backend = "oss"
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: settings)
    user_a.storage_limit_bytes = 100
    db.add(File(user_id=user_a.id, display_name="file", ext="bin", storage_key="file", size_bytes=20))
    await db.flush()

    rows = await quota_ledger.ensure_user_storage_space(db, user_a)
    await quota_ledger.record_usage(
        db, user_a.id, category=quota_ledger.SHELL_PERSISTENT,
        delta_bytes=10, operation="shell_exec", idempotency_key="oss-shell-write",
    )
    file_quota = await quota_ledger.get_quota(db, user_a.id, quota_ledger.FILE_LIBRARY)
    shell_quota = await quota_ledger.get_quota(db, user_a.id, quota_ledger.SHELL_PERSISTENT)

    assert file_quota.used_bytes == 20
    assert file_quota.limit_bytes == 100
    assert shell_quota.used_bytes == 10
    assert shell_quota.limit_bytes == 512
