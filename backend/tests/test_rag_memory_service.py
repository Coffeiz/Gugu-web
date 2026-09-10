"""search_memory 统一查询链契约：Memory-only 瞬态规格、来源过滤与语料收口。

旧 legacy 交付链的预算/截断断言已随链删除；字符预算由 TS worker 的排序
契约负责（worker protocol 测试覆盖）。
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from agent.rag.models import IndexDocument, Scope

SCOPE = Scope("user-a")


@pytest.fixture(autouse=True)
def _disable_persistent_index_in_service_tests(monkeypatch):
    from agent.rag.adapters.memory import MemoryAdapter

    async def owner_documents(self, *, scope):
        return await self.build_documents(scope=scope), "owner-test"

    monkeypatch.setattr(MemoryAdapter, "build_cached_owner_documents", owner_documents)


def _memory_doc(source_id="daily", content="缓存记忆正文"):
    return IndexDocument(
        f"memory:{source_id}", "memory", source_id, SCOPE, "记忆", "", content, "v1",
    )


def _selected_row(document, document_key, *, confidence=0.9):
    return {
        "document_key": document_key, "text": document.content, "confidence": confidence,
        "source_quality": 0.8, "normalized_score": 1.0, "fused_score": 0.5,
        "raw_score": 1.5, "citation": {"chunk_id": document.chunk_id},
        "citations": [{"chunk_id": document.chunk_id}],
    }


def _install_unified_memory_stubs(monkeypatch, *, documents, selected=None):
    """打桩统一查询 IPC 与索引会话，捕获瞬态规格、来源过滤与排序参数。"""
    from agent.rag import batch_retriever as br
    from agent.rag.index_cache import _worker_document_key

    calls = {}
    keys = {_worker_document_key(doc): doc for doc in documents}

    async def fake_load_memory(self, memory, scope):
        calls["source_filter"] = memory.source_filter
        return list(documents), "daily", {"document_load_ms": 1}

    async def replace_transient(docs, revision, *, vectors=None, vector_version=""):
        calls["transient"] = list(docs)

    async def unified_query(query, *, searches, query_vector, source_order,
                            candidate_limit, rank_options, before_message_id=None,
                            vector_version=None):
        calls["searches"] = searches
        calls["rank_options"] = rank_options
        rows = list(selected or ())
        return {
            "selected": rows,
            "stats": {"candidate_count": len(rows), "accepted_count": len(rows),
                      "top_confidence": 0.9, "threshold": 0.35, "preferred_threshold": 0.55,
                      "selection_mode": "top_k", "scoring_version": "confidence-v4",
                      "elapsed_ms": 2, "source_diagnostics": {}},
            "fusion": {"fusion": "bm25"},
            "document_counts": {"memory": len(documents)},
            "source_groups": {"memory": {"candidate_count": len(documents), "hit_count": len(rows)}},
        }

    index = SimpleNamespace(
        client=SimpleNamespace(replace_transient=replace_transient),
        unified_query=unified_query,
        documents_by_id=keys,
    )

    @asynccontextmanager
    async def session_scope(self):
        yield object()

    async def get(*args, **kwargs):
        calls["prepare"] = True
        return index

    monkeypatch.setattr(br.UnifiedQueryRetriever, "_load_memory", fake_load_memory)
    monkeypatch.setattr(br.IndexedSourceRetriever, "session_scope", session_scope)
    monkeypatch.setattr(br, "get_index_cache", lambda: SimpleNamespace(get=get))
    return calls, keys


@pytest.mark.asyncio
async def test_memory_only_query_delivers_worker_selection(monkeypatch):
    """Memory-only 显式查询走统一链：只发瞬态规格，交付 worker 选中行。"""
    from agent.rag.service import search_memory

    doc = _memory_doc()
    calls, keys = _install_unified_memory_stubs(monkeypatch, documents=[doc])
    # document_key 必须用真实 worker 键，否则回连不到 Python 文档。
    from agent.rag.index_cache import _worker_document_key

    calls, keys = _install_unified_memory_stubs(
        monkeypatch, documents=[doc],
        selected=[_selected_row(doc, _worker_document_key(doc))])

    result = await search_memory("user-a", "缓存", limit=5)

    assert calls["prepare"]
    assert [spec.get("corpus") for spec in calls["searches"]] == ["transient"]
    assert calls["source_filter"] == "all"
    assert calls["rank_options"]["selection_mode"] == "top_k"
    assert result["results"]
    item = result["results"][0]
    assert item["text"] == doc.content
    assert item["confidence"] == 0.9
    assert item["citation"] == {"chunk_id": doc.chunk_id}
    assert item["citations"] == [{"chunk_id": doc.chunk_id}]
    assert result["engine"] == "typescript"


@pytest.mark.asyncio
async def test_memory_search_passes_source_filter_and_unknown_source_stays_empty(monkeypatch):
    """source 细分值进入语料装载过滤；不匹配任何注册来源时返回空结果。"""
    from agent.rag import service

    calls, _keys = _install_unified_memory_stubs(monkeypatch, documents=[])

    async def empty_rank(_owner, _query, _candidates, **_kwargs):
        return [], {"candidate_count": 0, "accepted_count": 0, "rejected_low_score": 0,
                    "rejected_not_preferred": 0, "rejected_duplicate": 0, "rejected_parent": 0,
                    "rejected_source": 0, "rejected_similarity": 0, "output_chars": 0,
                    "top_confidence": 0.0, "threshold": 0.35, "preferred_threshold": 0.55,
                    "selection_mode": "top_k", "scoring_version": "confidence-v4",
                    "elapsed_ms": 0}

    monkeypatch.setattr(service, "rank_candidates_with_cache", empty_rank)
    result = await service.search_memory("user-a", "缓存", source="daily", limit=5)
    assert result["results"] == []

    result = await service.search_memory("user-a", "缓存", source="knowledge", limit=5)
    assert result["results"] == []


@pytest.mark.asyncio
async def test_memory_search_accepts_current_group_scope(monkeypatch):
    from agent.rag.service import search_memory

    _install_unified_memory_stubs(monkeypatch, documents=[])
    result = await search_memory(
        "user-a", "事件", scope="current_group",
        im_context={
            "platform": "qq", "chat_type": "group", "chat_id": "group-1",
            "channel_id": "bot-1", "im_role": "member", "puid": "member-1",
        },
    )
    assert result["results"] == []


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
async def test_memory_recall_documents_filters_source_and_scope(monkeypatch):
    """语料装载按 source_filter 收口来源命名空间（原 owner-namespace 契约）。"""
    from agent.rag import service

    docs = [
        _memory_doc(source_id="profile", content="档案内容"),
        _memory_doc(source_id="daily", content="日记内容"),
    ]

    async def fake_owner_documents(self, *, scope):
        return docs, "owner-test"

    monkeypatch.setattr(service.MemoryAdapter, "build_cached_owner_documents", fake_owner_documents)

    loaded, index_source, _ms = await service._memory_recall_documents("user-a", SCOPE, "all")
    assert [item.source_id for item in loaded] == ["profile", "daily"]
    assert index_source == "owner-test"

    loaded, _source, _ms = await service._memory_recall_documents("user-a", SCOPE, "daily")
    assert [item.source_id for item in loaded] == ["daily"]


@pytest.mark.asyncio
async def test_memory_recall_documents_excludes_chunks_already_in_snapshot(monkeypatch):
    """已注入 snapshot 的 chunk 在语料装载时排除，避免工具结果重复占上下文。"""
    from agent.rag import context, service

    covered = "已经注入 snapshot 的记忆内容"
    uncovered = "只存在于 snapshot 注入预算之外的历史内容"
    docs = [IndexDocument(
        f"memory:daily-{index}", "memory", "daily", SCOPE, "记忆", "", text, "v1",
    ) for index, text in enumerate((covered, uncovered))]

    async def fake_owner_documents(self, *, scope):
        return docs, "owner-test"

    monkeypatch.setattr(service.MemoryAdapter, "build_cached_owner_documents", fake_owner_documents)
    context.set_snapshot_context(f"## 最近的记忆\n{covered}")
    try:
        loaded, _source, _ms = await service._memory_recall_documents("user-a", SCOPE, "all")
    finally:
        context.set_snapshot_context("")

    assert [item.content for item in loaded] == [uncovered]
