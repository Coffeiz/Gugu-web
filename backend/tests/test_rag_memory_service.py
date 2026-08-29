import pytest


@pytest.fixture(autouse=True)
def _disable_persistent_index_in_service_tests(monkeypatch):
    from agent.rag.adapters.memory import MemoryAdapter

    async def owner_documents(self, *, scope):
        return await self.build_documents(scope=scope), "owner-test"

    monkeypatch.setattr(MemoryAdapter, "build_cached_owner_documents", owner_documents)


@pytest.mark.asyncio
async def test_memory_search_reads_only_owner_namespace(monkeypatch):
    from agent.rag.adapters import memory as memory_adapter
    from agent.rag.service import search_memory

    async def fake_profile(_):
        return [{"id": "p1", "text": "用户喜欢稳定的缓存结构"}]

    async def fake_patterns(_):
        return []

    async def fake_daily(_):
        return ["2026-08-24 讨论了 RAG 记忆召回"]

    async def fake_memory(_):
        return "## 记录长期记忆：缓存\n之前验证过跨轮缓存命中率。"

    monkeypatch.setattr(memory_adapter.store, "read_profile_list", fake_profile)
    monkeypatch.setattr(memory_adapter.store, "read_pattern_list", fake_patterns)
    monkeypatch.setattr(memory_adapter.store, "read_daily_lines", fake_daily)
    monkeypatch.setattr(memory_adapter.store, "read_memory_doc", fake_memory)

    result = await search_memory("user-a", "缓存", limit=5)
    assert result["strategy"] == "bm25"
    assert result["results"]
    assert all(item["source"] in {"profile", "daily", "memory"} for item in result["results"])
    assert result["results"][0]["citation"]["source_type"] == result["results"][0]["source"]
    assert result["results"][0]["citations"]


@pytest.mark.asyncio
async def test_memory_search_accepts_current_group_scope(monkeypatch):
    from agent.rag.service import search_memory

    monkeypatch.setattr(
        "agent.rag.adapters.memory.MemoryAdapter.build_documents",
        lambda *_args, **_kwargs: _empty_async_result(),
    )
    result = await search_memory(
        "user-a", "事件", scope="current_group",
        im_context={
            "platform": "qq", "chat_type": "group", "chat_id": "group-1",
            "channel_id": "bot-1", "im_role": "member", "puid": "member-1",
        },
    )
    assert result["results"] == []


async def _empty_async_result():
    return []


@pytest.mark.asyncio
async def test_memory_query_scope_rejects_private_memory_for_member():
    from agent.rag.scope import resolve_memory_query_scopes

    with pytest.raises(PermissionError):
        await resolve_memory_query_scopes(
            "user-a", "private_memory",
            im_context={"platform": "qq", "chat_type": "group", "im_role": "member"},
        )


@pytest.mark.asyncio
async def test_memory_query_scope_rejects_private_memory_in_owner_group():
    from agent.rag.scope import resolve_memory_query_scopes

    with pytest.raises(PermissionError):
        await resolve_memory_query_scopes(
            "user-a", "private_memory",
            im_context={
                "platform": "qq", "chat_type": "group", "chat_id": "g1",
                "channel_id": "bot", "im_role": "owner",
            },
        )


@pytest.mark.asyncio
async def test_memory_search_respects_total_output_budget(monkeypatch):
    from agent.rag import service
    from agent.rag.models import IndexDocument, Scope

    scope = Scope(owner_user_id="user-a")
    documents = [IndexDocument(
        document_id=f"memory:daily:{index}",
        source_type="memory",
        source_id="daily",
        scope=scope,
        title="近期记忆",
        summary="缓存",
        content="缓存" * size,
        version=f"v{index}",
    ) for index, size in enumerate((1200, 1200, 1200))]

    async def fake_build_documents(self, *, scope):
        return documents

    monkeypatch.setattr(service.MemoryAdapter, "build_documents", fake_build_documents)

    result = await service.search_memory("user-a", "缓存", limit=10)

    assert sum(len(item["text"]) for item in result["results"]) <= service.MAX_OUTPUT_CHARS
    assert service.MAX_OUTPUT_CHARS == 3000


@pytest.mark.asyncio
async def test_memory_search_truncates_first_oversized_chunk(monkeypatch):
    from agent.rag import service
    from agent.rag.models import IndexDocument, Scope

    scope = Scope(owner_user_id="user-a")
    document = IndexDocument(
        document_id="memory:daily:oversized",
        source_type="memory",
        source_id="daily",
        scope=scope,
        title="近期记忆",
        summary="缓存",
        content="缓存" * 2000,
        version="v1",
    )

    async def fake_build_documents(self, *, scope):
        return [document]

    monkeypatch.setattr(service.MemoryAdapter, "build_documents", fake_build_documents)

    result = await service.search_memory("user-a", "缓存", limit=5)

    assert len(result["results"]) == 1
    assert len(result["results"][0]["text"]) == service.MAX_OUTPUT_CHARS


@pytest.mark.asyncio
async def test_memory_search_excludes_chunks_already_in_snapshot(monkeypatch):
    from agent.rag import context, service
    from agent.rag.models import IndexDocument, Scope

    scope = Scope(owner_user_id="user-a")
    covered = "已经注入 snapshot 的记忆内容"
    uncovered = "只存在于 snapshot 注入预算之外的历史内容"
    documents = [IndexDocument(
        document_id=f"memory:daily:{index}",
        source_type="memory",
        source_id="daily",
        scope=scope,
        title="近期记忆",
        summary="历史内容",
        content=text,
        version=f"v{index}",
    ) for index, text in enumerate((covered, uncovered))]

    async def fake_build_documents(self, *, scope):
        return documents

    monkeypatch.setattr(service.MemoryAdapter, "build_documents", fake_build_documents)
    context.set_snapshot_context(f"## 最近的记忆\n{covered}")
    try:
        result = await service.search_memory("user-a", "历史内容", limit=10)
    finally:
        context.set_snapshot_context("")

    assert [item["text"] for item in result["results"]] == [uncovered]
