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
    from agent.memory import memory_compress as compress, store

    uid = "memory-test"
    await store.write_daily_lines(uid, [f"- 2026-08-24 新事件{i}" for i in range(1, 101)])
    captured = {}

    async def failed_recall(*_args, **_kwargs):
        raise RuntimeError("index unavailable")

    async def fake_complete(_sys, user, _settings, **_kwargs):
        captured["user"] = user
        return {"entries": "## 记录长期记忆：新事件\n\n2026-08-24 新事件已完成。"}

    async def fake_sync(*_args, **_kwargs):
        return None

    monkeypatch.setattr(compress, "retrieve_event_references", failed_recall)
    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)
    monkeypatch.setattr(compress.store, "sync_memory_vecs", fake_sync)
    await store.write_memory_doc(uid, "## 记录长期记忆：既有事件\n\n2026-08-01 旧内容保留。")

    assert await compress.compact(uid, SimpleNamespace()) is True
    assert "暂无相关历史事件参考" in captured["user"]
    assert "已有的长期记忆" not in captured["user"]
    assert "旧内容保留" in await store.read_memory_doc(uid)
    assert "新事件已完成" in await store.read_memory_doc(uid)


@pytest.mark.asyncio
async def test_memory_compaction_retries_provider_without_context_branch(monkeypatch, storage):
    from agent.memory import memory_compress as compress, store

    uid = "memory-retry-test"
    await store.write_daily_lines(uid, [f"- 2026-08-24 新事件{i}" for i in range(1, 101)])
    calls = 0

    async def flaky_complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("provider timeout")
        return {"entries": "## 记录长期记忆：重试事件\n\n2026-08-24 重试后完成。"}

    async def fake_sync(*_args, **_kwargs):
        return None

    async def no_references(*_args, **_kwargs):
        return []

    monkeypatch.setattr("agent.context.provider_runner.complete_json", flaky_complete)
    monkeypatch.setattr(compress.store, "sync_memory_vecs", fake_sync)
    monkeypatch.setattr(compress, "retrieve_event_references", no_references)

    assert await compress.compact(uid, SimpleNamespace()) is True
    assert calls == 2


@pytest.mark.asyncio
async def test_memory_compaction_does_not_consume_daily_when_model_has_no_new_entry(monkeypatch, storage):
    from agent.memory import memory_compress as compress, store

    uid = "memory-empty-test"
    lines = [f"- 2026-08-24 重复事件{i}" for i in range(1, 101)]
    await store.write_daily_lines(uid, lines)

    async def fake_complete(*_args, **_kwargs):
        return {"entries": ""}

    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)

    assert await compress.compact(uid, SimpleNamespace()) is False
    assert await store.read_daily_lines(uid) == lines


@pytest.mark.asyncio
async def test_memory_compaction_appends_multiple_event_entries(monkeypatch, storage):
    from agent.memory import memory_compress as compress, store

    uid = "memory-multiple-events-test"
    await store.write_daily_lines(uid, [f"- 2026-08-24 记录{i}" for i in range(1, 101)])

    async def fake_complete(*_args, **_kwargs):
        return {"entries": (
            "## 记录长期记忆：项目进展\n\n"
            "- 时间：2026-08-24\n"
            "- 类型：项目工作\n"
            "- 状态：进行中\n\n"
            "### 事件经过\n完成接口联调。\n\n"
            "## 记录长期记忆：生活开心事\n\n"
            "- 时间：2026-08-24\n"
            "- 类型：开心时刻\n"
            "- 状态：已发生\n\n"
            "### 事件经过\n用户提到今天收到了一份惊喜。"
        )}

    async def fake_sync(*_args, **_kwargs):
        return None

    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete)
    monkeypatch.setattr(compress.store, "sync_memory_vecs", fake_sync)

    assert await compress.compact(uid, SimpleNamespace()) is True
    memory = await store.read_memory_doc(uid)
    assert memory.count("## 记录长期记忆：") == 2
    assert "项目进展" in memory
    assert "生活开心事" in memory
