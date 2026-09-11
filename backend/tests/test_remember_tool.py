"""remember 工具的 remove 参数：画像/行为模式的工具层删除入口。

此前底层 apply_profile_ops/apply_pattern_ops 一直支持 remove，但工具没暴露，
用户要求「忘掉某条画像」时咕咕没有工具可调（知识有 delete_knowledge，这里不对称）。
"""

from __future__ import annotations

import pytest

from agent import events
from agent.memory import store as memory_store
from agent.tools.memory import _remember
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
async def test_remember_removes_profile_entry_by_fuzzy_text(memory_storage, memory_events):
    await _remember(None, "user-a", {
        "text": "preferred IDE is PyCharm", "type": "preference",
    })
    result = await _remember(None, "user-a", {
        "target": "profile", "remove": ["preferred IDE is PyCharm"],
    })

    assert result["success"] is True
    assert result["removed"] == 1
    assert result["added"] == 0
    profile = await memory_store.read_profile_list("user-a")
    assert profile == []
    assert memory_events[-1].removed == 1
    assert memory_events[-1].added == 0


@pytest.mark.asyncio
async def test_remember_removes_pattern_and_keeps_vec_cache_consistent(memory_storage, memory_events, monkeypatch):
    synced = []

    async def fake_sync(user_id, patterns, *args, **kwargs):
        synced.append(patterns)

    monkeypatch.setattr(memory_store, "sync_pattern_vecs", fake_sync)
    await _remember(None, "user-a", {
        "text": "部署前先跑 trivy 预扫", "target": "pattern", "importance": 4,
    })
    result = await _remember(None, "user-a", {
        "target": "pattern", "remove": ["部署前先跑 trivy 预扫"],
    })

    assert result["success"] is True
    assert result["removed"] == 1
    patterns = await memory_store.read_pattern_list("user-a")
    assert patterns == []
    # 删除后仍同步向量缓存（内部 GC 已删 pattern 的向量），不能跳过
    assert len(synced) == 2


@pytest.mark.asyncio
async def test_remember_supports_remove_and_add_in_one_round(memory_storage, memory_events):
    await _remember(None, "user-a", {"text": "住在杭州", "type": "address"})
    result = await _remember(None, "user-a", {
        "target": "profile",
        "text": "住在苏州",
        "type": "address",
        "remove": ["住在杭州"],
    })

    assert result["success"] is True
    assert result["removed"] == 1
    assert result["remembered"] == "住在苏州"
    profile = await memory_store.read_profile_list("user-a")
    assert len(profile) == 1
    assert profile[0]["text"] == "住在苏州"


@pytest.mark.asyncio
async def test_remember_remove_only_requires_no_text(memory_storage, memory_events):
    result = await _remember(None, "user-a", {"target": "profile", "remove": ["不存在的条目"]})

    assert result["success"] is True
    assert result["removed"] == 0
    profile = await memory_store.read_profile_list("user-a")
    assert profile == []


@pytest.mark.asyncio
async def test_remember_rejects_missing_text_and_remove(memory_storage, memory_events):
    result = await _remember(None, "user-a", {"target": "profile"})
    assert "text" in result["error"] and "remove" in result["error"]


def test_remember_schema_declares_remove():
    from agent.tools import registry

    tool = registry.get("remember")
    assert tool.input_schema["properties"]["remove"] == {"type": "array", "items": {"type": "string"}}
    assert "remove" not in (tool.input_schema.get("required") or [])
    assert "search_memory" in tool.description
