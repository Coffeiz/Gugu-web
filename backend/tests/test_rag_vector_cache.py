import json

import pytest


@pytest.mark.asyncio
async def test_rag_vector_cache_uses_document_keys_and_keeps_legacy_memory(monkeypatch):
    from agent.rag.models import IndexDocument, Scope
    from agent.rag.vector_cache import cache_key, sync_memory_index_vectors
    from agent.memory import embedding

    scope = Scope(owner_user_id="user-a")
    documents = [
        IndexDocument(
            document_id="memory:daily:0",
            source_type="memory",
            source_id="daily",
            scope=scope,
            title="近期记忆",
            summary="测试",
            content="近期测试内容",
            version="v1",
            metadata={"vector_key": "daily:0"},
        ),
        IndexDocument(
            document_id="memory:pattern:p1",
            source_type="memory",
            source_id="pattern",
            scope=scope,
            title="行为模式",
            summary="测试",
            content="pattern",
            version="v1",
            metadata={"vector_key": "p1"},
        ),
    ]
    stored = {"legacy-memory-key": {"v": [9.0], "t": "old"}}
    written = {}

    monkeypatch.setattr(embedding, "is_enabled", lambda: True)
    monkeypatch.setattr(embedding, "model_tag", lambda: "test:model:1")
    async def fake_embed(text):
        return [float(len(text))]
    monkeypatch.setattr(embedding, "embed", fake_embed)
    async def fake_read(_uid):
        return _copy(stored)
    monkeypatch.setattr("agent.memory.store.read_memory_vecs", fake_read)
    async def fake_write(_uid, values):
        written.update(values)
    monkeypatch.setattr("agent.memory.store.write_memory_vecs", fake_write)

    assert cache_key(documents[0]) == f"rag:daily:{documents[0].content_hash}"
    assert cache_key(documents[1]) is None
    assert await sync_memory_index_vectors("user-a", documents, force=True) == 1
    assert "legacy-memory-key" in written
    assert cache_key(documents[0]) in written


@pytest.mark.asyncio
async def test_knowledge_vectors_use_dedicated_file_and_migrate_legacy_memory(tmp_path, monkeypatch):
    from agent.knowledge.vector_cache import KNOWLEDGE_VECTOR_FILE, sync_vectors
    from agent.memory import embedding
    from agent.rag.models import IndexDocument, Scope
    from agent.rag.vector_cache import cache_key
    from app.services.storage import LocalStorageBackend

    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("agent.knowledge.vector_cache.get_storage", lambda: backend)
    monkeypatch.setattr(embedding, "is_enabled", lambda: True)
    monkeypatch.setattr(embedding, "model_tag", lambda: "test:model:1")

    async def fake_embed(text):
        return [float(len(text))]

    monkeypatch.setattr(embedding, "embed", fake_embed)
    legacy = {
        "rag:knowledge-old:hash": {"v": [1.0], "t": "old"},
        "rag:memory:hash": {"v": [2.0], "t": "old"},
    }
    remaining = {}

    async def fake_read(_uid):
        return dict(legacy)

    async def fake_write(_uid, values):
        remaining.update(values)

    monkeypatch.setattr("agent.memory.store.read_memory_vecs", fake_read)
    monkeypatch.setattr("agent.memory.store.write_memory_vecs", fake_write)

    document = IndexDocument(
        document_id="knowledge:new", source_type="knowledge", source_id="knowledge-new",
        scope=Scope(owner_user_id="user-a"), title="知识", summary="测试",
        content="新的知识", version="1", metadata={},
    )

    assert await sync_vectors("user-a", [document]) == 1
    keys = await backend.list_keys()
    assert keys == [f"user-a/{KNOWLEDGE_VECTOR_FILE}"]
    assert "rag:knowledge-old:hash" not in remaining
    assert remaining["rag:memory:hash"] == {"v": [2.0], "t": "old"}
    stored = json.loads((await backend.get(keys[0])).decode())
    assert cache_key(document) in stored
    assert stored[cache_key(document)]["v"] == [4.0]


def _copy(value):
    return {key: dict(item) for key, item in value.items()}
