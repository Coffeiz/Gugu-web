"""事件总线索引更新的串行化与合并回归测试。"""

import asyncio

import pytest


@pytest.mark.asyncio
async def test_rag_index_events_coalesce_and_drain_latest_event(monkeypatch):
    from agent.events import bus, types

    key = ("user-event-bus", "knowledge")
    calls = []
    first_started = asyncio.Event()
    release_first = asyncio.Event()

    async def fake_index_update(event):
        calls.append(event.operation)
        if len(calls) == 1:
            first_started.set()
            await release_first.wait()
        return True

    monkeypatch.setattr(bus, "_log_rag_index_updated", fake_index_update)
    bus._rag_pending.pop(key, None)
    bus._rag_status.pop(key, None)
    worker = bus._rag_workers.pop(key, None)
    if worker is not None:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)

    try:
        bus._enqueue_rag_index_event(types.RagIndexUpdated(
            user_id=key[0], source_type=key[1], operation="upsert",
        ))
        await first_started.wait()

        # 当前重建尚未完成时只保留最后一个事件；delete 代表当前主数据最终状态。
        bus._enqueue_rag_index_event(types.RagIndexUpdated(
            user_id=key[0], source_type=key[1], operation="upsert",
        ))
        bus._enqueue_rag_index_event(types.RagIndexUpdated(
            user_id=key[0], source_type=key[1], operation="delete",
        ))
        release_first.set()
        worker = bus._rag_workers[key]
        await worker

        assert calls == ["upsert", "delete"]
        assert bus.get_rag_index_status(*key) == {
            "state": "ready",
            "generation": 3,
            "completed_generation": 3,
            "pending": False,
        }
    finally:
        bus._rag_pending.pop(key, None)
        bus._rag_status.pop(key, None)
        worker = bus._rag_workers.pop(key, None)
        if worker is not None and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
