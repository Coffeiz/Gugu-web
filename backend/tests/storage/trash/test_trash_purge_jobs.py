"""回收站后台任务的并发、冷却和用户隔离契约。"""

import asyncio
import json

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.v1 import trash as trash_api
from app.core import events
from app.core.tz import now_utc
from app.db import session as db_session
from app.models import File, TrashPurgeJob
from app.services.files import trash_purge
from app.services.files.trash_purge import _claim


async def test_global_worker_claims_at_most_one_purge(db, user_a, user_b):
    db.add_all([
        TrashPurgeJob(user_id=user_a.id, status="queued", snapshot_at=now_utc(), progress_total=1),
        TrashPurgeJob(user_id=user_b.id, status="queued", snapshot_at=now_utc(), progress_total=1),
    ])
    await db.commit()

    first = await _claim(db_session._SessionLocal, "worker-one")
    second = await _claim(db_session._SessionLocal, "worker-two")

    assert first is not None
    assert second is None


async def test_database_constraint_rejects_two_running_purge_jobs(db, user_a, user_b):
    db.add(TrashPurgeJob(user_id=user_a.id, status='running', snapshot_at=now_utc(), progress_total=1))
    await db.commit()

    db.add(TrashPurgeJob(user_id=user_b.id, status='running', snapshot_at=now_utc(), progress_total=1))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    running = (await db.execute(select(TrashPurgeJob).where(TrashPurgeJob.status == 'running'))).scalars().all()
    assert len(running) == 1


async def test_purge_job_status_cannot_be_read_by_another_user(db, user_a, user_b):
    job = TrashPurgeJob(
        user_id=user_b.id,
        status="queued",
        snapshot_at=now_utc(),
        progress_total=1,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    with pytest.raises(HTTPException) as exc:
        await trash_api.get_empty_trash_job(job.id, current_user=user_a, db=db)
    assert exc.value.status_code == 404


async def test_completed_purge_has_short_repeat_cooldown(db, user_a):
    db.add(TrashPurgeJob(
        user_id=user_a.id,
        status="completed",
        snapshot_at=now_utc(),
        progress_total=4,
        progress_current=4,
        finished_at=now_utc(),
    ))
    await db.commit()

    with pytest.raises(HTTPException) as exc:
        await trash_api.start_empty_trash(current_user=user_a, db=db)
    assert exc.value.status_code == 429
    assert exc.value.headers["Retry-After"] == "30"


async def test_queued_purge_publishes_wakeup_after_persisting_job(db, user_a, monkeypatch):
    class FakeRedis:
        def __init__(self):
            self.published = []

        async def publish(self, channel, message):
            self.published.append((channel, message))
            return 1

    redis = FakeRedis()
    monkeypatch.setattr(trash_purge, "get_redis", lambda: redis)
    db.add(File(
        user_id=user_a.id,
        display_name="合成测试文件",
        ext="txt",
        storage_key="test/trash-wakeup.txt",
        deleted_at=now_utc(),
    ))
    await db.commit()

    job, created = await trash_purge.enqueue_purge(db, user_a.id)

    assert created is True
    assert job.status == "queued"
    assert redis.published == [(trash_purge._WAKE_CHANNEL, "1")]


async def test_purge_progress_is_published_to_the_owner_live_channel(monkeypatch, user_a):
    class FakeRedis:
        def __init__(self):
            self.published = []

        async def publish(self, channel, message):
            self.published.append((channel, json.loads(message)))

    redis = FakeRedis()
    monkeypatch.setattr(events, "get_redis", lambda: redis)

    await events.publish_trash_purge_progress(
        user_a.id, job_id=7, status="running", progress_current=10,
        progress_total=24, failed_count=0,
    )

    channel, payload = redis.published[0]
    assert channel == f"events:{user_a.id}"
    assert payload["type"] == "task.progress"
    assert payload["task_type"] == "trash_purge"
    assert payload["task_id"] == 7
    assert payload["progress_current"] == 10
    assert payload["progress_total"] == 24


async def test_idle_worker_sleeps_until_wakeup_then_claims_job(monkeypatch):
    class FakePubSub:
        def __init__(self):
            self.messages = asyncio.Queue()

        async def subscribe(self, _channel):
            return None

        async def listen(self):
            while True:
                yield {"type": "message", "data": await self.messages.get()}

        async def unsubscribe(self, _channel):
            return None

        async def aclose(self):
            return None

    class FakeRedis:
        def __init__(self):
            self.pubsubs = []

        def pubsub(self):
            pubsub = FakePubSub()
            self.pubsubs.append(pubsub)
            return pubsub

        async def publish(self, _channel, _message):
            for pubsub in self.pubsubs:
                await pubsub.messages.put({"type": "message", "data": "1"})
            return len(self.pubsubs)

    redis = FakeRedis()
    stop_event = asyncio.Event()
    first_claim = asyncio.Event()
    calls = 0

    async def claim(_session_factory, _worker_id):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_claim.set()
            return None
        return 42

    async def process(_job_id, _worker_id, _session_factory):
        stop_event.set()

    monkeypatch.setattr(trash_purge, "get_redis", lambda: redis)
    monkeypatch.setattr(trash_purge, "_claim", claim)
    monkeypatch.setattr(trash_purge, "_process", process)
    monkeypatch.setattr(trash_purge, "_RECOVERY_SCAN_SECONDS", 30)

    worker = asyncio.create_task(trash_purge.run_trash_purge_worker(
        stop_event, worker_id="test-worker", session_factory=object(),
    ))
    try:
        await asyncio.wait_for(first_claim.wait(), timeout=1)
        await asyncio.sleep(0.02)
        assert calls == 1

        await trash_purge._notify_worker()
        await asyncio.wait_for(stop_event.wait(), timeout=1)
        assert calls == 2
    finally:
        stop_event.set()
        await asyncio.wait_for(worker, timeout=1)


async def test_worker_recovers_queued_job_when_redis_is_unavailable(monkeypatch):
    stop_event = asyncio.Event()
    calls = 0

    def unavailable_redis():
        raise ConnectionError("redis unavailable")

    async def claim(_session_factory, _worker_id):
        nonlocal calls
        calls += 1
        return None if calls == 1 else 42

    async def process(_job_id, _worker_id, _session_factory):
        stop_event.set()

    monkeypatch.setattr(trash_purge, "get_redis", unavailable_redis)
    monkeypatch.setattr(trash_purge, "_claim", claim)
    monkeypatch.setattr(trash_purge, "_process", process)
    monkeypatch.setattr(trash_purge, "_RECOVERY_SCAN_SECONDS", 0.01)
    monkeypatch.setattr(trash_purge, "diag_log", lambda *_args: None)

    await asyncio.wait_for(trash_purge.run_trash_purge_worker(
        stop_event, worker_id="test-worker", session_factory=object(),
    ), timeout=1)

    assert calls == 2
