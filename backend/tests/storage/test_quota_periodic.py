"""周期校准只处理到期的活跃用户，并限制单轮批量。"""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core.tz import now_utc
from app.models import StorageQuotaLedger
from app.services.storage.quota_ledger import FILE_LIBRARY
from app.services.storage.quota_periodic import reconcile_due_storage_users


@pytest.mark.asyncio
async def test_periodic_quota_reconcile_limits_to_due_active_users(
    db, user_a, user_b, monkeypatch,
):
    timestamp = now_utc()
    user_a.is_active = True
    user_b.is_active = False
    due = StorageQuotaLedger(
        user_id=user_a.id, category=FILE_LIBRARY, used_bytes=10,
        limit_bytes=100, status="active",
        last_reconciled_at=timestamp - timedelta(days=8),
    )
    inactive = StorageQuotaLedger(
        user_id=user_b.id, category=FILE_LIBRARY, used_bytes=20,
        limit_bytes=100, status="active",
        last_reconciled_at=timestamp - timedelta(days=8),
    )
    db.add_all((due, inactive))
    await db.flush()
    processed = []

    async def reconcile(_db, user_id, *, preserve_concurrent_updates):
        assert preserve_concurrent_updates is True
        processed.append(user_id)
        row = await db.scalar(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id,
            StorageQuotaLedger.category == FILE_LIBRARY,
        ))
        row.last_reconciled_at = timestamp
        return {FILE_LIBRARY: row.used_bytes}

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", reconcile,
    )

    count = await reconcile_due_storage_users(db, now=timestamp, batch_size=1)
    await db.refresh(due)
    await db.refresh(inactive)

    assert count == 1
    assert processed == [user_a.id]
    assert due.last_reconciled_at == timestamp
    assert inactive.last_reconciled_at == timestamp - timedelta(days=8)


@pytest.mark.asyncio
async def test_periodic_quota_reconcile_honors_batch_limit(db, user_a, user_b, monkeypatch):
    timestamp = now_utc()
    user_a.is_active = user_b.is_active = True
    db.add_all([
        StorageQuotaLedger(
            user_id=user_id, category=FILE_LIBRARY, used_bytes=0,
            limit_bytes=100, status="active",
            last_reconciled_at=timestamp - timedelta(days=8),
        )
        for user_id in (user_a.id, user_b.id)
    ])
    await db.flush()
    processed = []

    async def reconcile(_db, user_id, *, preserve_concurrent_updates):
        processed.append(user_id)
        row = await db.scalar(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id,
            StorageQuotaLedger.category == FILE_LIBRARY,
        ))
        row.last_reconciled_at = timestamp
        return {FILE_LIBRARY: 0}

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", reconcile,
    )

    count = await reconcile_due_storage_users(db, now=timestamp, batch_size=1)

    assert count == 1
    assert len(processed) == 1
