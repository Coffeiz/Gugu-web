from datetime import datetime, timezone
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
