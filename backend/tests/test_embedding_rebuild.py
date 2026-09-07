import asyncio

import pytest


@pytest.mark.asyncio
async def test_rebuild_all_vecs_uses_bounded_cross_user_concurrency(monkeypatch):
    from agent.memory import store

    active = 0
    peak = 0
    completed = []

    async def fake_patterns(_uid):
        return [{"id": "p1", "text": "测试"}]

    async def fake_memory(_uid):
        return "长期记忆"

    async def fake_sync_pattern(_uid, _patterns, force=False, strict=False):
        nonlocal active, peak
        assert force is True
        assert strict is True
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        active -= 1
        return 1

    async def fake_sync_memory(_uid, _memory, force=False, strict=False):
        nonlocal active, peak
        assert force is True
        assert strict is True
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        active -= 1
        return 1

    async def progress(done, total):
        completed.append((done, total))

    monkeypatch.setattr(store, "VECTOR_REBUILD_CONCURRENCY", 2)
    monkeypatch.setattr(store, "read_pattern_list", fake_patterns)
    monkeypatch.setattr(store, "read_memory_doc", fake_memory)
    monkeypatch.setattr(store, "sync_pattern_vecs", fake_sync_pattern)
    monkeypatch.setattr(store, "sync_memory_vecs", fake_sync_memory)

    result = await store.rebuild_all_vecs(["u1", "u2", "u3", "u4"], on_progress=progress)

    assert result == {
        "done": 4,
        "total": 4,
        "with_patterns": 4,
        "pattern_vectors": 4,
        "memory_vectors": 4,
        "failed_users": 0,
    }
    assert peak <= 2
    assert completed == [(1, 4), (2, 4), (3, 4), (4, 4)]
