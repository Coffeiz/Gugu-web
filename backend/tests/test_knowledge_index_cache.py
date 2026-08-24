import pytest

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


@pytest.mark.asyncio
async def test_index_cache_reuses_per_source_and_keeps_users_isolated(db, user_a, user_b):
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
    assert first.search("alpha")
    assert other.search("alpha") == []
    assert cache.stats()["entries"] == 2


@pytest.mark.asyncio
async def test_index_cache_revision_invalidates_after_incremental_replace(db, user_a):
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
    assert second.search("beta")
    assert second.search("alpha") == []
