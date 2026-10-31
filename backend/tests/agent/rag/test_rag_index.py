import pytest

from agent.events.types import RagIndexUpdated
from agent.rag.models import IndexDocument, Scope


def _doc(version: str, position: int = 0):
    return IndexDocument(
        "memory:event", "memory", "memory", Scope("user-a"), "事件", "", "内容", version,
        chunk_index=position, parent_document_id="memory:event",
    )


def test_index_invalidation_keeps_snapshot_baseline():
    from agent.rag.index_cache import KnowledgeIndexCache, _Entry
    import time

    cache = KnowledgeIndexCache()
    cache._entries[("user-a", "python", "all")] = _Entry(
        object(), 1, "current", "python", time.monotonic(),
    )
    cache._entries[("user-a", "typescript", "shared:snapshot:7")] = _Entry(
        object(), 1, "7", "typescript", time.monotonic(),
    )

    cache.invalidate("user-a")

    assert ("user-a", "python", "all") not in cache._entries
    assert ("user-a", "typescript", "shared:snapshot:7") in cache._entries


@pytest.mark.asyncio
async def test_cython_backend_is_selected_once_for_unified_query(monkeypatch):
    """Cython 配置应走统一索引/查询，不触发 TS，也能复用进程缓存。"""
    from types import SimpleNamespace

    from agent.rag import cython_lifecycle
    from agent.rag.index_cache import KnowledgeIndexCache

    settings = SimpleNamespace(search=SimpleNamespace(rag_backend="cython"))
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    monkeypatch.setattr("agent.memory.embedding.is_enabled", lambda: False)
    monkeypatch.setattr("agent.memory.embedding.model_tag", lambda: "")
    monkeypatch.setattr(
        "agent.rag.index_cache.get_lexical_client",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("TS 不应被调用")),
    )

    document = IndexDocument(
        "knowledge:airport", "knowledge", "knowledge", Scope("user-a"),
        "机场账单异常", "", "流量账单出现异常，已复核并重置。", "v1",
        parent_document_id="knowledge:airport",
    )
    loaded_dirs = []

    async def load_snapshot(self, db, owner_user_id, index_dir, *, vector_version="", revision=None):
        loaded_dirs.append(str(index_dir))
        self._owner_user_id = str(owner_user_id)
        self.engine.replace([document], str(revision or "revision-1"))
        return {"status": "ok", "document_count": 1, "vector_count": 0}

    monkeypatch.setattr(cython_lifecycle.CythonRagLifecycle,
                        "load_index_from_snapshot_or_database", load_snapshot)
    cache = KnowledgeIndexCache()
    first = await cache.get(object(), "user-a", "all", baseline_revision="revision-1")
    second = await cache.get(object(), "user-a", "all", baseline_revision="revision-1")

    assert first is second
    assert len(loaded_dirs) == 1
    assert "cython" in loaded_dirs[0]
    response = await first.unified_query(
        "机场账单异常", searches=[{"source_types": {"knowledge"}}],
        source_order=["knowledge"], candidate_limit=5,
        rank_options={"limit": 5, "max_chars": 3000, "selection_mode": "top_k"},
    )
    assert response["status"] == "ok"
    assert response["selected"]
    assert response["selected"][0]["document"]["source_type"] == "knowledge"


@pytest.mark.asyncio
async def test_cython_transient_search_returns_recall_results(monkeypatch):
    """能力目录的 transient 召回走 Cython 时仍返回既有 RecallResult 列表契约。"""
    from types import SimpleNamespace

    import agent.rag.index_cache as index_cache

    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(search=SimpleNamespace(rag_backend="cython")),
    )
    monkeypatch.setattr(index_cache, "_CACHE", index_cache.KnowledgeIndexCache())
    documents = [IndexDocument(
        "memory:event", "memory", "memory", Scope("user-a"), "机场账单异常", "",
        "机场账单异常：已完成复核并恢复。", "v1",
        parent_document_id="memory:event",
    )]

    results = await index_cache.search_documents_with_cache(
        "user-a", documents, "机场账单异常", source_types={"memory"},
        scope=Scope("user-a"),
    )

    assert isinstance(results, list)
    assert results
    assert results[0].document.content == documents[0].content


@pytest.mark.asyncio
async def test_persistent_memory_index_roundtrip(monkeypatch):
    from agent.rag.storage import PersistentMemoryIndex
    import agent.rag.storage as storage_module

    class FakeStorage:
        def __init__(self):
            self.data = {}

        async def get(self, key):
            if key not in self.data:
                raise FileNotFoundError(key)
            return self.data[key]

        async def put(self, key, data, mime_type=None):
            self.data[key] = data

        async def delete(self, key):
            self.data.pop(key, None)

    backend = FakeStorage()
    monkeypatch.setattr(storage_module, "get_storage", lambda: backend)
    source = _doc("v1", 0)
    source = IndexDocument(
        source.document_id, source.source_type, source.source_id, source.scope,
        source.title, source.summary, source.content, source.version,
        chunk_index=source.chunk_index, chunk_count=2,
        parent_document_id=source.parent_document_id,
        metadata={"vector_key": "k1"},
    )

    index = PersistentMemoryIndex("user-a")
    await index.replace([source])
    loaded = await index.load()

    assert loaded is not None
    assert loaded[0].identity() == source.identity()
    assert loaded[0].scope == source.scope
    assert loaded[0].metadata == {"vector_key": "k1"}


@pytest.mark.asyncio
async def test_memory_index_worker_retries_three_times(monkeypatch):
    from agent.rag import pipeline

    calls = 0

    async def fake_rebuild(user_id, *, operation):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise OSError("temporary")
        return 4

    async def no_sleep(_):
        return None

    monkeypatch.setattr(pipeline, "rebuild_memory_index", fake_rebuild)
    monkeypatch.setattr(pipeline.asyncio, "sleep", no_sleep)

    await pipeline.handle_memory_index_event(RagIndexUpdated(user_id="user-a"))

    assert calls == 3
