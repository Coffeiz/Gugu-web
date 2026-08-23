import pytest

from agent.events.types import RagIndexUpdated
from agent.rag.index import InMemoryIndex
from agent.rag.models import IndexDocument, Scope


def _doc(version: str, position: int = 0):
    return IndexDocument(
        "memory:event", "memory", "memory", Scope("user-a"), "事件", "", "内容", version,
        chunk_index=position, parent_document_id="memory:event",
    )


def test_upsert_replaces_old_document_version():
    index = InMemoryIndex()
    index.upsert(_doc("v1", 0))
    index.upsert(_doc("v1", 1))
    index.upsert(_doc("v2", 0))
    assert [item.version for item in index.documents()] == ["v2"]


def test_invalidate_removes_all_chunks():
    index = InMemoryIndex()
    index.upsert(_doc("v1", 0))
    index.upsert(_doc("v1", 1))
    assert index.invalidate("memory:event") == 2
    assert index.documents() == []


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
