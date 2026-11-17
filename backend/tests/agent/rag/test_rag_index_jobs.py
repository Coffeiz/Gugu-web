"""RAG 索引持久任务的合并、失败重试和成功收敛回归测试。"""
import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_rag_index_job_coalesces_and_retries_after_failure(db, user_a, monkeypatch):
    from agent.events.types import RagIndexUpdated
    from agent.rag import index_jobs
    from app.core.tz import now_utc
    from app.models import RagIndexJob

    monkeypatch.setattr(index_jobs, "_is_ephemeral_sqlite", lambda _session_factory: False)

    event = RagIndexUpdated(
        user_id=user_a.id,
        source_type="knowledge",
        source_id="knowledge",
        operation="upsert",
    )
    first_generation = await index_jobs.persist_event(event)
    second_generation = await index_jobs.persist_event(
        RagIndexUpdated(
            user_id=user_a.id,
            source_type="knowledge",
            source_id="knowledge",
            operation="delete",
        )
    )

    assert first_generation == 1
    assert second_generation == 2
    assert await index_jobs.mark_running(event) == 2
    delay = await index_jobs.mark_result(event, 2, success=False)
    assert delay and delay > 0

    row = (
        await db.execute(
            select(RagIndexJob).where(
                RagIndexJob.user_id == user_a.id,
                RagIndexJob.source_type == "knowledge",
            )
        )
    ).scalar_one()
    assert row.operation == "delete"
    assert row.status == "retrying"
    assert row.attempts == 1
    assert row.completed_generation == 0

    retry_time = now_utc() + timedelta(seconds=delay + 1)
    monkeypatch.setattr(index_jobs, "now_utc", lambda: retry_time)
    due = await index_jobs.due_events()
    assert len(due) == 1
    # pending_source_ids 展开的重放事件统一 upsert：最终动作由当前主数据
    # 决定（对象已删时投影为空、按 delete 收敛），不信任旧事件的 operation。
    assert due[0].operation == "upsert"
    assert due[0].source_id == "knowledge"

    assert await index_jobs.mark_running(due[0]) == 2
    assert await index_jobs.mark_result(due[0], 2, success=True) == 0.0
    await db.refresh(row)
    assert row.status == "ready"
    assert row.completed_generation == 2


@pytest.mark.asyncio
async def test_memory_update_persists_node_consumable_source_rebuild(db, user_a, monkeypatch):
    """Node consumer recognizes the source-level memory event emitted by Python."""
    from agent.events.types import RagIndexUpdated
    from agent.rag import index_jobs
    from app.models import RagIndexJob

    monkeypatch.setattr(index_jobs, "_is_ephemeral_sqlite", lambda _session_factory: False)
    event = RagIndexUpdated(
        user_id=user_a.id,
        source_type="memory",
        source_id="memory",
        operation="upsert",
    )

    assert await index_jobs.persist_event(event) == 1
    row = (
        await db.execute(
            select(RagIndexJob).where(
                RagIndexJob.user_id == user_a.id,
                RagIndexJob.source_type == "memory",
            )
        )
    ).scalar_one()
    assert row.source_id == "memory"
    assert row.pending_source_ids == ["memory"]
    assert row.operation == "upsert"
    assert row.status == "queued"


@pytest.mark.asyncio
async def test_node_worker_owner_keeps_python_memory_event_as_producer_only(monkeypatch):
    """Node 为唯一消费者时，Python 仍持久化事件但不得启动本地 Worker。"""
    from agent.events import bus
    from agent.events.types import RagIndexUpdated

    owner = "test-memory-owner-node-consumer"
    key = (owner, "memory")
    calls = []
    monkeypatch.setattr(bus, "_python_rag_worker_enabled", lambda: False)

    async def persist(event, *, python_worker_enabled):
        calls.append((event, python_worker_enabled))

    monkeypatch.setattr(bus, "_persist_rag_event_and_start", persist)
    bus._rag_pending.pop(key, None)
    bus._rag_workers.pop(key, None)
    event = RagIndexUpdated(user_id=owner, source_type="memory", source_id="memory")
    prior_tasks = set(bus._tasks)
    bus.publish(event)
    new_tasks = tuple(task for task in bus._tasks if task not in prior_tasks)
    if new_tasks:
        await asyncio.gather(*new_tasks)

    assert calls == [(event, False)]
    assert key not in bus._rag_pending
    assert key not in bus._rag_workers
