from types import SimpleNamespace

import pytest
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.memory.store.get_storage", lambda: backend)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: backend)
    return backend


@pytest.mark.asyncio
async def test_retrieve_event_references_caps_results_and_uses_owner_memory(monkeypatch):
    from agent.memory import memory_references

    captured = {}

    async def fake_search(*args, **kwargs):
        captured.update(kwargs)
        return {"results": [
            {"title": f"事件{i}", "text": f"事实{i}", "content_hash": f"h{i}"}
            for i in range(20)
        ]}

    monkeypatch.setattr("agent.rag.service.search_memory", fake_search)
    refs = await memory_references.retrieve_event_references(
        "owner", ["2026-08-24 新事件"], limit=20,
    )

    assert len(refs) == 10
    assert captured["source"] == "memory"
    assert captured["strategy"] == "bm25"
    assert captured["scope"].scope_type == "owner"


@pytest.mark.asyncio
async def test_compaction_keeps_working_when_event_recall_fails(monkeypatch, storage):
    from agent.memory import compress, store

    uid = "memory-test"
    await store.write_daily_lines(uid, [f"- 2026-08-24 新事件{i}" for i in range(1, 101)])
    captured = {}

    async def failed_recall(*_args, **_kwargs):
        raise RuntimeError("index unavailable")

    async def fake_complete(_sys, user, _settings, **_kwargs):
        captured["user"] = user
        return {"memory": "## 记录长期记忆：新事件\n\n2026-08-24 新事件已完成。"}

    async def fake_sync(*_args, **_kwargs):
        return None

    monkeypatch.setattr(compress, "retrieve_event_references", failed_recall)
    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)
    monkeypatch.setattr(compress.store, "sync_memory_vecs", fake_sync)

    assert await compress.compact(uid, SimpleNamespace()) is True
    assert "暂无相关历史事件参考" in captured["user"]
    assert "新事件已完成" in await store.read_memory_doc(uid)
