import pytest
from types import SimpleNamespace

from agent.rag.index_cache import KnowledgeIndexCache, PythonLexicalIndex
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
    """缓存测试只验证 revision/owner 隔离，不依赖本机架构的 Rust 二进制。"""
    from agent.rag.models import RecallResult

    class FakeSidecar:
        def __init__(self, *_args, **_kwargs):
            pass

        async def replace(self, _documents, _revision):
            return None

        async def search(self, query, *, documents, **_kwargs):
            needle = query.casefold()
            return [
                RecallResult(document, 1.0)
                for document in documents.values()
                if needle in (document.title + document.summary + document.content).casefold()
            ]

        async def close(self):
            return None

    monkeypatch.setattr("agent.rag.index_cache.RustSidecarClient", FakeSidecar)


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
async def test_python_backend_reuses_transient_owner_index(monkeypatch):
    document = _document("user-a", "项目 alpha", "v1")
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(search=SimpleNamespace(
            rust_lexical_backend="python", rust_sidecar_enabled=True,
        )),
    )
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)

    first = await cache.get_transient("user-a", [document], revision="v1")
    second = await cache.get_transient("user-a", [document], revision="v1")

    assert isinstance(first, PythonLexicalIndex)
    assert first is second
    assert [item.document.source_id for item in await second.search("alpha")] == ["1"]
    assert cache.stats()["entries"] == 1


@pytest.mark.asyncio
async def test_backend_switch_does_not_reuse_other_backend_cache(monkeypatch):
    document = _document("user-a", "项目 alpha", "v1")
    settings = SimpleNamespace(search=SimpleNamespace(
        rust_lexical_backend="python", rust_sidecar_enabled=True,
        rust_sidecar_command="", rust_sidecar_index_dir="",
    ))
    monkeypatch.setattr("app.core.config.get_settings", lambda: settings)
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    python_index = await cache.get_transient("user-a", [document], revision="v1")

    class FakeSidecar:
        def __init__(self, *_args, **_kwargs):
            pass

        async def replace(self, _documents, _revision):
            return None

        async def search(self, query, *, documents, **_kwargs):
            return []

        async def close(self):
            return None

    monkeypatch.setattr("agent.rag.index_cache.RustSidecarClient", FakeSidecar)
    settings.search.rust_lexical_backend = "rust"
    rust_index = await cache.get_transient("user-a", [document], revision="v1")

    assert isinstance(python_index, PythonLexicalIndex)
    assert rust_index is not python_index
    assert cache.stats()["entries"] == 2


@pytest.mark.asyncio
async def test_cache_build_reuses_persistent_sidecar_revision(monkeypatch):
    document = _document("user-a", "项目 alpha", "v1")
    settings = SimpleNamespace(search=SimpleNamespace(
        rust_lexical_backend="rust", rust_sidecar_enabled=True,
        rust_sidecar_command="/opt/gugu-rag-sidecar", rust_sidecar_index_dir="/var/lib/gugu/rag-index",
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

    monkeypatch.setattr("agent.rag.index_cache.RustSidecarClient", PersistentSidecar)
    cache = KnowledgeIndexCache(ttl_seconds=1800, owner_limit_bytes=10_000_000)
    first = await cache.get_transient("user-a", [document], revision="v1")
    assert isinstance(first, object)
    assert calls == {"reuse": 1, "replace": 0}
