"""统一索引缓存的 Cython 行为回归。"""
from types import SimpleNamespace

import pytest

from agent.rag.index_cache import KnowledgeIndexCache
from agent.rag.models import IndexDocument, RecallResult, Scope


def _document(owner: str, content: str, source_id: str = "1") -> IndexDocument:
    return IndexDocument(
        document_id=f"project:{source_id}", source_type="project", source_id=source_id,
        scope=Scope(owner_user_id=owner), title="测试项目", summary=content,
        content=content, version="v1",
    )


class _FakeIndex:
    def __init__(self, documents):
        self.documents = list(documents)
        self.document_count = len(self.documents)
        self.estimated_bytes = 1024

    async def search(self, query, *, source_types=(), scope=None, limit=10):
        query_terms = query.casefold().split()
        selected = [
            RecallResult(document, 1.0)
            for document in self.documents
            if (not source_types or document.source_type in set(source_types))
            and any(term in (document.title + document.summary + document.content).casefold()
                    for term in query_terms)
        ]
        return selected[:limit]


@pytest.fixture
def use_fake_index(monkeypatch):
    async def build(self, _backend, _owner, documents, revision, _settings, diagnostics=None,
                    previous_documents=None, previous_revision=None,
                    allow_database_load=False, cache_scope="all", db=None):
        if documents is None and allow_database_load:
            from agent.rag.persistent_store import load_index_documents
            documents = await load_index_documents(db, _owner)
        return _FakeIndex(documents or ())

    monkeypatch.setattr(KnowledgeIndexCache, "_build_index", build)
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(search=SimpleNamespace(rag_index_ttl_seconds=30 * 24 * 3600)),
    )


@pytest.mark.asyncio
async def test_transient_index_cache_is_owner_scoped_and_reuses_same_revision(use_fake_index):
    cache = KnowledgeIndexCache()
    document = _document("user-a", "alpha")
    first = await cache.get_transient("user-a", [document], revision="v1")
    second = await cache.get_transient("user-a", [document], revision="v1")
    other_owner = await cache.get_transient("user-b", [document], revision="v1")

    assert first is second
    assert other_owner is not first
    assert [result.document.content for result in await first.search("alpha")] == ["alpha"]


@pytest.mark.asyncio
async def test_transient_revision_change_replaces_cached_documents(use_fake_index):
    cache = KnowledgeIndexCache()
    first = await cache.get_transient("user-a", [_document("user-a", "alpha")], revision="v1")
    second = await cache.get_transient("user-a", [_document("user-a", "beta")], revision="v2")

    assert first is not second
    assert await second.search("alpha") == []
    assert [item.document.content for item in await second.search("beta")] == ["beta"]


@pytest.mark.asyncio
async def test_shared_snapshot_merges_sources_without_cross_owner_leak(use_fake_index):
    from agent.rag.context import reset_shared_index_key, set_shared_index_key

    cache = KnowledgeIndexCache()
    token = set_shared_index_key("snapshot:test")
    try:
        first = await cache.get_transient(
            "user-a", [_document("user-a", "alpha", "a")], revision="rev-a",
        )
        merged = await cache.get_transient(
            "user-a", [_document("user-a", "beta", "b")], revision="rev-b",
        )
        isolated = await cache.get_transient(
            "user-b", [_document("user-b", "gamma", "c")], revision="rev-c",
        )
        assert await first.search("alpha")
        assert {item.document.content for item in await merged.search("alpha beta")} == {"alpha", "beta"}
        assert await isolated.search("alpha") == []
    finally:
        reset_shared_index_key(token)
