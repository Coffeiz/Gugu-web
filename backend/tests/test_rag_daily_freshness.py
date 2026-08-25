import pytest


@pytest.mark.asyncio
async def test_persistent_memory_refreshes_daily_and_matches_compact_entity(monkeypatch):
    from agent.rag import service
    from agent.rag.models import IndexDocument, Scope

    scope = Scope(owner_user_id="user-a", scope_type="owner")

    class Index:
        def __init__(self, _):
            pass

        async def load(self):
            return [IndexDocument(
                document_id="memory:memory:0", source_type="memory", source_id="memory",
                scope=scope, title="项目与工作", content="一个旧项目", summary="一个旧项目",
                version="old",
            )]

    async def fresh_daily(self, *, scope):
        return [IndexDocument(
            document_id="memory:daily:0", source_type="memory", source_id="daily",
            scope=scope, title="近期记忆", content="最近在关注 GTA6 的消息",
            summary="最近在关注 GTA6 的消息", version="fresh",
        )]

    monkeypatch.setattr(service, "PersistentMemoryIndex", Index)
    monkeypatch.setattr(service.MemoryAdapter, "build_daily_documents", fresh_daily)
    documents, source = await service._load_memory_documents("user-a", scope)

    assert source == "persistent+daily-refresh"
    assert any(document.source_id == "daily" for document in documents)

    from agent.rag.legacy_lexical import LegacyBM25
    assert LegacyBM25(documents).search("GTA 6", limit=5)
