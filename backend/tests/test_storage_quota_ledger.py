from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import StorageQuotaEvent, StorageQuotaLedger
from app.services.storage import quota_ledger


def _settings(tmp_path):
    return SimpleNamespace(
        storage=SimpleNamespace(local_path=str(tmp_path)),
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

    assert (tmp_path / str(user_a.id) / "shell").is_dir()
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
    monkeypatch.setattr(quota_ledger, "get_settings", lambda: _settings(tmp_path))
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
    root = tmp_path / str(user_a.id) / "shell"
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
