"""/forget 命令的向量缓存 GC：删除 pattern 后必须立即同步存活集。

此前 forget 只写 pattern.json 不触发 sync_pattern_vecs，已删模式的向量要等
下一次新增 pattern 才被顺带回收，期间 embedding 检索仍可能召回幽灵向量。
"""

from __future__ import annotations

import pytest

from agent import events
from agent.commands import memory as memory_commands
from agent.memory import store as memory_store
from app.services.storage import LocalStorageBackend


@pytest.fixture
def memory_storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.memory.store.get_storage", lambda: backend)
    monkeypatch.setattr(memory_store, "get_storage", lambda: backend, raising=False)
    return backend


@pytest.fixture
def memory_events(monkeypatch):
    published = []
    monkeypatch.setattr(events, "publish", published.append)
    return published


@pytest.mark.asyncio
async def test_forget_pattern_syncs_vec_cache_with_kept_list(memory_storage, memory_events, monkeypatch):
    sync_calls = []

    async def fake_sync(user_id, patterns, *args, **kwargs):
        sync_calls.append(list(patterns))

    monkeypatch.setattr(memory_store, "sync_pattern_vecs", fake_sync)
    patterns = memory_store.apply_pattern_ops([], [{"text": "部署前先跑 trivy 预扫", "kind": "observed"}], [])
    await memory_store.write_pattern_list("user-a", patterns)

    reply = await memory_commands.forget("user-a", "trivy 预扫")

    assert "1 条" in reply
    assert await memory_store.read_pattern_list("user-a") == []
    assert len(sync_calls) == 1
    assert sync_calls[0] == []
    assert memory_events[-1].removed == 1


@pytest.mark.asyncio
async def test_forget_profile_only_does_not_touch_vec_cache(memory_storage, memory_events, monkeypatch):
    sync_calls = []

    async def fake_sync(user_id, patterns, *args, **kwargs):
        sync_calls.append(list(patterns))

    monkeypatch.setattr(memory_store, "sync_pattern_vecs", fake_sync)
    profile = memory_store.apply_profile_ops([], [{"type": "preference", "text": "偏好暗色主题"}], [])
    await memory_store.write_profile_list("user-a", profile)

    reply = await memory_commands.forget("user-a", "暗色主题")

    assert "1 条" in reply
    assert sync_calls == []


@pytest.mark.asyncio
async def test_forget_without_match_leaves_storage_untouched(memory_storage, memory_events, monkeypatch):
    sync_calls = []

    async def fake_sync(user_id, patterns, *args, **kwargs):
        sync_calls.append(list(patterns))

    monkeypatch.setattr(memory_store, "sync_pattern_vecs", fake_sync)
    patterns = memory_store.apply_pattern_ops([], [{"text": "部署前先跑 trivy 预扫", "kind": "observed"}], [])
    await memory_store.write_pattern_list("user-a", patterns)

    reply = await memory_commands.forget("user-a", "毫不相关的内容")

    assert "没找到" in reply
    assert sync_calls == []
    assert len(await memory_store.read_pattern_list("user-a")) == 1
