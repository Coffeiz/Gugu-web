"""Worker 并发热更新和 IM 队列准入的回归测试。"""

import asyncio
import json
from types import SimpleNamespace

import worker
from app.core import config


async def test_refresh_concurrency_releases_waiting_agent_slot(tmp_path, monkeypatch):
    override_file = tmp_path / "config.override.json"
    override_file.write_text(json.dumps({"agent": {"worker_concurrency": 2}}), encoding="utf-8")
    monkeypatch.setattr(config, "OVERRIDE_FILE", override_file)
    monkeypatch.setattr(worker, "_max_concurrency", 1)
    monkeypatch.setattr(worker, "_run_active", 0)
    monkeypatch.setattr(worker, "_run_condition", asyncio.Condition())
    first_started = asyncio.Event()
    second_started = asyncio.Event()
    release = asyncio.Event()
    active = 0
    peak = 0

    async def task():
        nonlocal active, peak
        async with worker._run_slot():
            active += 1
            peak = max(peak, active)
            first_started.set()
            if active == 2:
                second_started.set()
            await release.wait()
            active -= 1

    first = asyncio.create_task(task())
    await first_started.wait()
    second = asyncio.create_task(task())
    await asyncio.sleep(0)
    assert peak == 1

    await worker._refresh_concurrency()
    await asyncio.wait_for(second_started.wait(), timeout=1)
    assert peak == 2
    assert worker._max_concurrency == 2

    release.set()
    await asyncio.gather(first, second)


async def test_run_once_keeps_unacked_backlog_out_of_process(monkeypatch):
    queued = [(f"msg-{i}", {"text": "synthetic"}) for i in range(5)]
    release = asyncio.Event()

    async def claim_stale(*_args, **_kwargs):
        return []

    async def consume(*_args, count, **_kwargs):
        batch = queued[:count]
        del queued[:count]
        return batch

    async def hold_message_in_buffer(msg_id, _payload):
        worker._buffered_message_ids.update((msg_id,))
        await release.wait()

    monkeypatch.setattr(worker, "R", SimpleNamespace(claim_stale=claim_stale, consume=consume))
    monkeypatch.setattr(worker, "_max_concurrency", 1)
    monkeypatch.setattr(worker, "_dispatch", hold_message_in_buffer)
    worker._inflight.clear()
    worker._pending_message_ids.clear()
    worker._buffered_message_ids.clear()

    try:
        assert await worker.run_once(block_ms=0) == 2
        while len(worker._buffered_message_ids) < 2:
            await asyncio.sleep(0)

        assert len(worker._pending_message_ids) == 2
        assert await worker.run_once(block_ms=0) == 0
        assert len(queued) == 3

        release.set()
        await asyncio.gather(*list(worker._inflight))
        assert len(worker._pending_message_ids) == 2  # 防抖缓冲仍占着准入额度

        async def ack(*_args):
            return 1

        worker.R.ack = ack
        await worker._ack_inbound("msg-0")
        assert len(worker._pending_message_ids) == 1
    finally:
        release.set()
        if worker._inflight:
            await asyncio.gather(*list(worker._inflight), return_exceptions=True)
        worker._inflight.clear()
        worker._pending_message_ids.clear()
        worker._buffered_message_ids.clear()


async def test_run_once_does_not_redispatch_local_pending_claim_and_uses_free_slot(monkeypatch):
    queued = [("new-msg", {"text": "synthetic"})]
    dispatched = []

    async def claim_stale(*_args, **_kwargs):
        return [("active-msg", {"text": "already running"})]

    async def consume(*_args, count, **_kwargs):
        batch = queued[:count]
        del queued[:count]
        return batch

    async def dispatch(msg_id, _payload):
        dispatched.append(msg_id)

    monkeypatch.setattr(worker, "R", SimpleNamespace(claim_stale=claim_stale, consume=consume))
    monkeypatch.setattr(worker, "_max_concurrency", 1)
    monkeypatch.setattr(worker, "_dispatch", dispatch)
    worker._inflight.clear()
    worker._pending_message_ids.clear()
    worker._pending_message_ids.add("active-msg")
    worker._buffered_message_ids.clear()

    try:
        assert await worker.run_once(block_ms=0) == 1
        await asyncio.gather(*list(worker._inflight))
        assert dispatched == ["new-msg"]
        assert "active-msg" in worker._pending_message_ids
    finally:
        worker._inflight.clear()
        worker._pending_message_ids.clear()
        worker._buffered_message_ids.clear()


async def test_imseen_duplicate_is_not_acked_while_original_handler_may_still_run(monkeypatch):
    acknowledged = []

    class Redis:
        async def set(self, *_args, **_kwargs):
            return False

    async def ack(msg_id):
        acknowledged.append(msg_id)

    monkeypatch.setattr(worker.R, "get_redis", lambda: Redis())
    monkeypatch.setattr(worker, "_ack_inbound", ack)

    await worker._dispatch("duplicate-msg", {"text": "synthetic"})

    assert acknowledged == []
