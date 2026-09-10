"""RAG 索引持久任务的合并、失败重试和成功收敛回归测试。"""
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
    assert due[0].operation == "delete"

    assert await index_jobs.mark_running(due[0]) == 2
    assert await index_jobs.mark_result(due[0], 2, success=True) == 0.0
    await db.refresh(row)
    assert row.status == "ready"
    assert row.completed_generation == 2
