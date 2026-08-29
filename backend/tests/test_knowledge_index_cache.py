import pytest
from types import SimpleNamespace

from agent.rag.index_cache import KnowledgeIndexCache
from agent.rag.models import IndexDocument, Scope
from agent.rag.persistent_store import replace_source_documents


def _document(user_id: str, content: str, version: str) -> IndexDocument:
    return IndexDocument(
        document_id="project:1",
        source_type="project",
        source_id="1",
        scope=Scope(owner_user_id=user_id),
        title="测试项目",
        summary=content,
        content=content,
        version=version,
    )


def _use_fake_sidecar(monkeypatch):
    """缓存测试只验证 revision/owner 隔离，不启动真实 TS worker。"""
    from agent.rag.models import RecallResult

    class FakeSidecar:
        def __init__(self, *_args, **_kwargs):
            pass

        async def replace(self, _documents, _revision):
            return None

        async def reuse_if_current(self, _revision):
            return False

        async def search(self, query, *, documents, source_types=(), scope=None, **_kwargs):
            needle = query.casefold()
            return [
                RecallResult(document, 1.0)
                for document in documents.values()
                if (not source_types or document.source_type in set(source_types))
                and needle in (document.title + document.summary + document.content).casefold()
            ]

        async def close(self):
            return None

    async def get_fake_sidecar(*_args, **_kwargs):
        return FakeSidecar()

    monkeypatch.setattr("agent.rag.index_cache.get_lexical_client", get_fake_sidecar)


@pytest.mark.asyncio
async def test_index_cache_reuses_per_source_and_keeps_users_isolated(db, user_a, user_b, monkeypatch):
    _use_fake_sidecar(monkeypatch)
    await replace_source_documents(
        db, user_a.id, "project", [_document(str(user_a.id), "项目 alpha", "v1")]
    )
    await db.commit()
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)

    first = await cache.get(db, user_a.id, "project")
    second = await cache.get(db, user_a.id, "project")
    other = await cache.get(db, user_b.id, "project")

    assert first is second
    assert first is not other
    assert await first.search("alpha")
    assert await other.search("alpha") == []
    assert cache.stats()["entries"] == 2


@pytest.mark.asyncio
async def test_index_cache_revision_invalidates_after_incremental_replace(db, user_a, monkeypatch):
    _use_fake_sidecar(monkeypatch)
    await replace_source_documents(
        db, user_a.id, "project", [_document(str(user_a.id), "项目 alpha", "v1")]
    )
    await db.commit()
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    first = await cache.get(db, user_a.id, "project")

    await replace_source_documents(
        db, user_a.id, "project", [_document(str(user_a.id), "项目 beta", "v2")]
    )
    await db.commit()
    second = await cache.get(db, user_a.id, "project")

    assert first is not second
    assert await second.search("beta")
    assert await second.search("alpha") == []


@pytest.mark.asyncio
async def test_shared_snapshot_index_merges_sources_and_filters_by_source(monkeypatch):
    from agent.rag.context import reset_shared_index_key, set_shared_index_key

    document_a = IndexDocument(
        document_id="memory:1", source_type="memory", source_id="1",
        scope=Scope(owner_user_id="user-a"), title="记忆", summary="",
        content="记忆 alpha", version="v1",
    )
    document_b = IndexDocument(
        document_id="project:2", source_type="project", source_id="2",
        scope=Scope(owner_user_id="user-a"), title="项目 beta", summary="",
        content="项目 beta", version="v1",
    )
    _use_fake_sidecar(monkeypatch)
    settings = SimpleNamespace(search=SimpleNamespace(
        ts_sidecar_command="", ts_sidecar_index_dir="",
    ))
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    token = set_shared_index_key("snapshot:revision-1")
    try:
        first = await cache.get_transient("user-a", [document_a], revision="memory-v1")
        second = await cache.get_transient("user-a", [document_b], revision="project-v1")
        assert first is not second
        assert len(second.documents) == 2
        assert [item.document.source_type for item in await second.search(
            "beta", source_types={"project"}
        )] == ["project"]
        assert await second.search("alpha", source_types={"project"}) == []
        assert cache.stats()["entries"] == 1
    finally:
        reset_shared_index_key(token)


@pytest.mark.asyncio
async def test_shared_snapshot_index_merges_persistent_and_transient_documents(monkeypatch):
    from agent.rag.context import reset_shared_index_key, set_shared_index_key

    persistent_document = _document("user-a", "项目 alpha", "v1")
    transient_document = IndexDocument(
        document_id="memory:1", source_type="memory", source_id="1",
        scope=Scope(owner_user_id="user-a"), title="记忆", summary="",
        content="记忆 beta", version="v1",
    )
    _use_fake_sidecar(monkeypatch)
    settings = SimpleNamespace(search=SimpleNamespace(
        ts_sidecar_command="", ts_sidecar_index_dir="",
    ))
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)

    async def load_documents(_db, _owner_user_id):
        return [persistent_document]

    monkeypatch.setattr("agent.rag.index_cache.load_index_documents", load_documents)
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    token = set_shared_index_key("snapshot:revision-1")
    try:
        index = await cache.get(
            object(), "user-a", "all", baseline_revision="db-v1",
        )
        merged = await cache.get_transient(
            "user-a", [transient_document], revision="memory-v1",
        )
        assert len(index.documents) == 1
        assert len(merged.documents) == 2
        assert cache.stats()["entries"] == 1
    finally:
        reset_shared_index_key(token)


@pytest.mark.asyncio
async def test_shared_snapshot_reuses_complete_persistent_index_without_loading_documents(monkeypatch):
    from agent.rag.context import reset_shared_index_key, set_shared_index_key

    document = _document("user-a", "项目 alpha", "v1")
    _use_fake_sidecar(monkeypatch)
    settings = SimpleNamespace(search=SimpleNamespace(
        ts_sidecar_command="", ts_sidecar_index_dir="",
    ))
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    calls = {"load": 0}

    async def load_documents(_db, _owner_user_id):
        calls["load"] += 1
        return [document]

    monkeypatch.setattr("agent.rag.index_cache.load_index_documents", load_documents)
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    token = set_shared_index_key("snapshot:revision-stable")
    try:
        first = await cache.get(object(), "user-a", "all", baseline_revision="revision-1")
        second = await cache.get(object(), "user-a", "all", baseline_revision="revision-1")
        assert first is second
        assert calls["load"] == 1
    finally:
        reset_shared_index_key(token)


@pytest.mark.asyncio
async def test_cache_build_reuses_persistent_sidecar_revision(monkeypatch):
    document = _document("user-a", "项目 alpha", "v1")
    settings = SimpleNamespace(search=SimpleNamespace(
        ts_sidecar_command="/opt/gugu-rag-ts-worker", ts_sidecar_index_dir="/var/lib/gugu/rag-ts-index",
    ))
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    calls = {"reuse": 0, "replace": 0}

    class PersistentSidecar:
        def __init__(self, *_args, **_kwargs):
            pass

        async def reuse_if_current(self, revision):
            calls["reuse"] += 1
            return revision == "v1"

        async def replace(self, _documents, _revision):
            calls["replace"] += 1

        async def search(self, query, *, documents, **_kwargs):
            return []

        async def close(self):
            return None

    async def get_persistent_sidecar(*_args, **_kwargs):
        return PersistentSidecar()

    monkeypatch.setattr("agent.rag.index_cache.get_lexical_client", get_persistent_sidecar)
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    first = await cache.get_transient("user-a", [document], revision="v1")
    assert isinstance(first, object)
    assert calls == {"reuse": 1, "replace": 0}
