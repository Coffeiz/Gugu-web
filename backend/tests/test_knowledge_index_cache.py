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
    """缓存测试只验证 revision/owner 隔离，不启动真实 TS worker/数据库通道。"""
    from agent.rag.models import RecallResult
    from agent.rag.ts_sidecar import SidecarRequestTiming

    class FakeSidecar:
        def __init__(self, *_args, **_kwargs):
            self.documents = {}
            self._document_count = 0
            self._estimated_bytes = 0
            self._revision = ""
            self._restore_error = None
            self._vector_version = ""

        async def replace(self, _documents, _revision, *, vectors=None, vector_version="", storage_owner_id=None):
            self.documents = {
                f"{document.source_type}:{document.parent_document_id or document.document_id}:{document.chunk_index}": document
                for document in _documents
            }
            self._document_count = len(self.documents)
            self._vector_version = vector_version
            return {"vector_count": 0, "vector_version": vector_version}

        async def database_revision(self, _owner_user_id):
            return None

        async def load_index_from_database(self, owner_user_id, revision, vector_version=""):
            from app.db import session as db_session
            from agent.rag.index_cache import load_index_documents

            if db_session._SessionLocal is None:
                documents = await load_index_documents(None, owner_user_id)
            else:
                async with db_session._SessionLocal() as db:
                    documents = await load_index_documents(db, owner_user_id)
            self.documents = {
                f"{document.source_type}:{document.parent_document_id or document.document_id}:{document.chunk_index}": document
                for document in documents
            }
            self._revision = revision
            self._vector_version = vector_version
            self._document_count = len(self.documents)
            self._estimated_bytes = 1024
            return {
                "document_count": self._document_count,
                "estimated_bytes": self._estimated_bytes,
                "vector_count": 0,
                "vector_version": vector_version,
                "probe": {
                    "stage_ms": {
                        "data_runtime_database_query": 12,
                        "index_install_build": 34,
                        "persist_serialize": 56,
                    },
                    "counts": {
                        "database_rows": self._document_count,
                        "documents": self._document_count,
                        "serialized_bytes": 1024,
                    },
                },
            }

        async def load_vectors_from_storage(self, _owner_user_id, vector_version):
            self._vector_version = vector_version
            return {"vector_count": 0, "vector_version": vector_version}

        async def reuse_if_current(self, _revision):
            return False

        async def search(self, query, *, documents, source_types=(), scope=None, **_kwargs):
            needle = query.casefold()
            return [
                RecallResult(document, 1.0)
                for document in (documents or self.documents).values()
                if (not source_types or document.source_type in set(source_types))
                and needle in (document.title + document.summary + document.content).casefold()
            ]

        async def search_with_timing(
            self, query, *, documents, source_types=(), scope=None, limit=10, **_kwargs
        ):
            return await self.search(
                query,
                documents=documents,
                source_types=source_types,
                scope=scope,
                limit=limit,
            ), SidecarRequestTiming()

        async def close(self):
            return None

    async def get_fake_sidecar(*_args, **_kwargs):
        return FakeSidecar()

    async def current_revision(self, db, owner_user_id, _backend, _settings):
        # 这些测试验证缓存状态机，不验证 TS Data Runtime 的 SQL 投影。
        return await self._revision(db, owner_user_id)

    monkeypatch.setattr("agent.rag.index_cache.get_lexical_client", get_fake_sidecar)
    monkeypatch.setattr(KnowledgeIndexCache, "_current_revision", current_revision)


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
async def test_shared_snapshot_index_keeps_persistent_documents_in_worker(monkeypatch):
    from agent.rag.context import reset_shared_index_key, set_shared_index_key

    persistent_document = _document("user-a", "项目 alpha", "v1")
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
        assert index.documents == []
        assert index.document_count == 1
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
            self._vector_version = ""

        async def reuse_if_current(self, revision):
            calls["reuse"] += 1
            return revision == "v1"

        async def load_vectors_from_storage(self, _owner_user_id, vector_version):
            self._vector_version = vector_version
            return {"vector_count": 0, "vector_version": vector_version}

        async def replace(self, _documents, _revision, *, vectors=None, vector_version="", storage_owner_id=None):
            calls["replace"] += 1
            self._vector_version = vector_version
            return {"vector_count": 0, "vector_version": vector_version}

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


@pytest.mark.asyncio
async def test_index_cache_probe_splits_cold_build_phases(db, user_a, monkeypatch):
    from agent.rag.observation import RecallObservation, current_recall

    _use_fake_sidecar(monkeypatch)
    await replace_source_documents(
        db, user_a.id, "project", [_document(str(user_a.id), "项目 alpha", "v1")]
    )
    await db.commit()
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    observation = RecallObservation()
    token = current_recall.set(observation)
    try:
        await cache.get(db, user_a.id, "all")
    finally:
        current_recall.reset(token)

    assert {
        "index_revision_read",
        "index_cache_lock_wait",
        "index_revision_recheck",
        "index_sidecar_restore",
        "index_ts_database_load",
        "index_worker_acquire",
        "index_worker_restore_check",
    } <= observation.probe["stage_ms"].keys()
    assert observation.probe["metrics"]["index_build"]["document_count"] == 1
    assert observation.probe["metrics"]["index_build"]["worker_revision_reused"] is False
    database_load_probe = observation.probe["metrics"]["index_ts_database_load"]
    assert database_load_probe["stage_ms"] == {
        "data_runtime_database_query": 12,
        "index_install_build": 34,
        "persist_serialize": 56,
    }
    assert database_load_probe["counts"] == {
        "database_rows": 1,
        "documents": 1,
        "serialized_bytes": 1024,
    }


@pytest.mark.asyncio
async def test_index_cache_resync_probe_separates_invalidation_and_forced_get(monkeypatch):
    from agent.rag.observation import RecallObservation, current_recall

    cache = KnowledgeIndexCache()
    invalidated = []

    def fake_invalidate(_owner, *, include_snapshot=False):
        invalidated.append(include_snapshot)
        return 3

    async def fake_get(*_args, **kwargs):
        assert kwargs["force"] is True
        return object()

    monkeypatch.setattr(cache, "invalidate", fake_invalidate)
    monkeypatch.setattr(cache, "get", fake_get)
    observation = RecallObservation()
    token = current_recall.set(observation)
    try:
        result = await cache.resync(object(), "synthetic-owner", "all")
    finally:
        current_recall.reset(token)

    assert result is not None
    assert invalidated == [True]
    assert "revision_cache_invalidate" in observation.probe["stage_ms"]
    assert "revision_resync_forced_index_get" in observation.probe["stage_ms"]
    assert observation.probe["metrics"]["revision_resync"]["invalidated_entry_count"] == 3


async def _empty_vector_table(*_args, **_kwargs):
    return {}, ""
