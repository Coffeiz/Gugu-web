import pytest


@pytest.mark.asyncio
async def test_persistent_memory_refreshes_daily_and_matches_compact_entity(monkeypatch):
    from agent.rag import service
    from agent.rag.models import IndexDocument, Scope

    scope = Scope(owner_user_id="user-a", scope_type="owner")

    async def owner_documents(self, *, scope):
        return [IndexDocument(
            document_id="memory:memory:0", source_type="memory", source_id="memory",
            scope=scope, title="项目与工作", content="一个旧项目", summary="一个旧项目",
            version="old",
        ), IndexDocument(
            document_id="memory:daily:0", source_type="memory", source_id="daily",
            scope=scope, title="近期记忆", content="最近在关注 GTA6 的消息",
            summary="最近在关注 GTA6 的消息", version="fresh",
        )], "persistent+daily-refresh"

    monkeypatch.setattr(service.MemoryAdapter, "build_cached_owner_documents", owner_documents)
    documents, source = await service._load_memory_documents("user-a", scope)

    assert source == "persistent+daily-refresh"
    assert any(document.source_id == "daily" for document in documents)

    assert any("GTA6" in document.content.replace(" ", "") for document in documents)


@pytest.mark.asyncio
async def test_daily_projection_is_reused_until_snapshot_revision_changes(monkeypatch):
    from agent.memory import store
    from agent.rag.adapters.memory import MemoryAdapter
    from agent.rag.context import set_snapshot_revision
    from agent.rag.models import Scope

    reads = 0

    async def read_daily(_user_id):
        nonlocal reads
        reads += 1
        return ["2026-08-26 固定的 daily 内容"]

    monkeypatch.setattr(store, "read_daily_lines", read_daily)
    MemoryAdapter._daily_cache.clear()
    MemoryAdapter._daily_locks.clear()
    scope = Scope(owner_user_id="user-a", scope_type="owner")
    adapter = MemoryAdapter("user-a")

    set_snapshot_revision(7)
    first, first_source = await adapter.build_cached_daily_documents(scope=scope)
    second, second_source = await adapter.build_cached_daily_documents(scope=scope)
    assert first == second
    assert first_source == "daily-refresh:7"
    assert second_source == "daily-cache:7"
    assert reads == 1

    set_snapshot_revision(8)
    third, third_source = await adapter.build_cached_daily_documents(scope=scope)
    assert third == first
    assert third_source == "daily-refresh:8"
    assert reads == 2
