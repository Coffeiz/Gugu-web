"""周期校准按并发上限持续处理到期活跃用户。"""
import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select
from uuid6 import uuid7

import app.db.session as db_session
from app.core.tz import now_utc
from app.models import StorageQuotaLedger, User
from app.services.storage.quota_ledger import FILE_LIBRARY, StorageScanBusyError
from app.services.storage.quota_periodic import reconcile_due_storage_users


async def _add_due_ledger(db, user_id, timestamp):
    db.add(StorageQuotaLedger(
        user_id=user_id, category=FILE_LIBRARY, used_bytes=0,
        limit_bytes=100, status="active",
        last_reconciled_at=timestamp - timedelta(days=8),
    ))


@pytest.mark.asyncio
async def test_periodic_reconcile_filters_inactive_and_not_due_users(
    db, user_a, user_b, monkeypatch,
):
    timestamp = now_utc()
    user_a.is_active = True
    user_b.is_active = False
    await _add_due_ledger(db, user_a.id, timestamp)
    await _add_due_ledger(db, user_b.id, timestamp)
    await db.flush()
    processed = []

    async def reconcile(_db, user_id, *, preserve_concurrent_updates):
        assert preserve_concurrent_updates is True
        processed.append(user_id)
        return {FILE_LIBRARY: 0}

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", reconcile,
    )

    count = await reconcile_due_storage_users(db_session._SessionLocal, now=timestamp)

    assert count == 1
    assert processed == [user_a.id]


@pytest.mark.asyncio
async def test_full_reconcile_includes_all_users_without_existing_ledgers(
    db, user_a, user_b, monkeypatch,
):
    user_a.is_active = True
    user_b.is_active = False
    await db.flush()
    processed = []
    progress = []

    async def reconcile(_db, user_id, *, preserve_concurrent_updates):
        assert preserve_concurrent_updates is True
        processed.append(user_id)
        return {FILE_LIBRARY: 0}

    async def report(value):
        progress.append(value)

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", reconcile,
    )

    count = await reconcile_due_storage_users(
        db_session._SessionLocal,
        include_all_users=True,
        progress_callback=report,
    )

    assert count == 2
    assert set(processed) == {user_a.id, user_b.id}
    assert progress[0] == {"total": 2, "processed": 0, "completed": 0, "failed": 0}
    assert progress[-1] == {"total": 2, "processed": 2, "completed": 2, "failed": 0}


@pytest.mark.asyncio
async def test_periodic_reconcile_drains_all_due_users_with_bounded_parallelism(
    db, user_a, user_b, monkeypatch,
):
    timestamp = now_utc()
    user_a.is_active = user_b.is_active = True
    user_ids = [user_a.id, user_b.id]
    for index in range(4):
        user = User(
            id=uuid7(), username=f"queue-user-{index}",
            email=f"queue-user-{index}@test.local", hashed_password="x",
        )
        db.add(user)
        user_ids.append(user.id)
    for user_id in user_ids:
        await _add_due_ledger(db, user_id, timestamp)
    await db.flush()

    started_fifth = asyncio.Event()
    release_first_wave = asyncio.Event()
    state_lock = asyncio.Lock()
    started = 0
    active = 0
    max_active = 0
    processed = []

    async def reconcile(_db, user_id, *, preserve_concurrent_updates):
        nonlocal started, active, max_active
        async with state_lock:
            started += 1
            this_started = started
            active += 1
            max_active = max(max_active, active)
            if started >= 5:
                started_fifth.set()
        if this_started <= 3:
            await release_first_wave.wait()
        async with state_lock:
            active -= 1
            processed.append(user_id)
        return {FILE_LIBRARY: 0}

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", reconcile,
    )

    task = asyncio.create_task(reconcile_due_storage_users(
        db_session._SessionLocal, now=timestamp, concurrency=4,
    ))
    try:
        await asyncio.wait_for(started_fifth.wait(), timeout=2)
    finally:
        release_first_wave.set()
    count = await task

    assert count == len(user_ids)
    assert set(processed) == set(user_ids)
    assert max_active == 4


@pytest.mark.asyncio
async def test_scan_busy_user_is_retried_then_worker_continues_queue(
    db, user_a, user_b, monkeypatch,
):
    timestamp = now_utc()
    user_a.is_active = user_b.is_active = True
    for user_id in (user_a.id, user_b.id):
        await _add_due_ledger(db, user_id, timestamp)
    await db.flush()
    attempts = {}
    processed = []

    async def busy_once_then_succeed(_db, user_id, *, preserve_concurrent_updates):
        attempts[user_id] = attempts.get(user_id, 0) + 1
        if user_id == user_a.id and attempts[user_id] == 1:
            raise StorageScanBusyError()
        processed.append(user_id)
        return {FILE_LIBRARY: 0}

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", busy_once_then_succeed,
    )
    monkeypatch.setattr("app.services.storage.quota_periodic.asyncio.sleep", no_wait)

    count = await reconcile_due_storage_users(
        db_session._SessionLocal, now=timestamp, concurrency=1,
    )

    assert count == 2
    assert attempts[user_a.id] == 2
    assert set(processed) == {user_a.id, user_b.id}


@pytest.mark.asyncio
async def test_persistently_busy_user_does_not_block_remaining_queue(
    db, user_a, user_b, monkeypatch,
):
    timestamp = now_utc()
    user_a.is_active = user_b.is_active = True
    for user_id in (user_a.id, user_b.id):
        await _add_due_ledger(db, user_id, timestamp)
    await db.flush()
    attempts = 0
    processed = []

    async def busy_first_user(_db, user_id, *, preserve_concurrent_updates):
        nonlocal attempts
        if user_id == user_a.id:
            attempts += 1
            raise StorageScanBusyError()
        processed.append(user_id)
        return {FILE_LIBRARY: 0}

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(
        "app.services.storage.quota_periodic.reconcile_user_storage", busy_first_user,
    )
    monkeypatch.setattr("app.services.storage.quota_periodic.asyncio.sleep", no_wait)

    count = await reconcile_due_storage_users(
        db_session._SessionLocal, now=timestamp, concurrency=1,
    )

    assert count == 1
    assert attempts == 3
    assert processed == [user_b.id]
