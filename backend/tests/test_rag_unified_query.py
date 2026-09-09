"""Phase 5 统一查询：retriever 单 IPC、预排序装配与影子隔离的单元契约。"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever

SCOPE = Scope("synthetic-owner")


def _file_doc():
    return IndexDocument("file-1", "file", "1", SCOPE, "文件", "", "缓存文件正文", "1")


def _memory_doc():
    return IndexDocument("daily-1", "memory", "daily", SCOPE, "记忆", "", "缓存记忆正文", "v1")


class _StubRetriever:
    """满足 UnifiedQueryRetriever 检索调度所需的最小来源桩。"""

    def __init__(self, user_id, source_type):
        self.user_id = user_id
        self.source_type = source_type
        self.source_filter = None

    @asynccontextmanager
    async def session_scope(self):
        yield object()


def _selected_row(document, document_key, *, confidence=0.9):
    return {
        "document_key": document_key, "text": document.content, "confidence": confidence,
        "source_quality": 0.8, "normalized_score": 1.0, "fused_score": 0.5,
        "raw_score": 1.5, "citation": {"chunk_id": document.chunk_id},
        "citations": [{"chunk_id": document.chunk_id}],
    }


def _canned_response(file_doc, memory_doc, file_key, memory_key, *, fallback=None):
    return {
        "selected": [
            _selected_row(file_doc, file_key),
            _selected_row(memory_doc, memory_key, confidence=0.7),
        ],
        "stats": {"candidate_count": 2, "accepted_count": 2, "top_confidence": 0.9,
                  "threshold": 0.35, "preferred_threshold": 0.55,
                  "selection_mode": "confidence", "scoring_version": "confidence-v1",
                  "elapsed_ms": 3, "source_diagnostics": {"file": {"candidate_count": 1}}},
        "fusion": {"fusion": "hybrid-rrf", "vector_doc_count": 1,
                   "vector_version": "prov:model:2", "fallback": fallback},
        "document_counts": {"file": 3, "memory": 1},
        "source_groups": {"file": {"candidate_count": 1, "hit_count": 1},
                          "memory": {"candidate_count": 1, "hit_count": 1}},
    }


def _install_unified_stubs(monkeypatch, *, canned, vector_map=None, model_tag="prov:model:2",
                           memory_documents=None, embedding_enabled=True):
    """打桩索引准备、瞬态语料上传、embedding 与统一查询 IPC，捕获调用事实。"""
    import agent.memory.embedding as embedding_mod
    from agent.rag import batch_retriever as br
    from agent.rag.batch_retriever import UnifiedQueryRetriever

    calls = {}

    async def replace_transient(documents, revision, *, vectors=None, vector_version=""):
        calls["transient"] = (list(documents), revision, vectors, vector_version)

    async def unified_query(query, *, searches, query_vector, source_order,
                            candidate_limit, rank_options, before_message_id=None):
        calls["query"] = {"query": query, "searches": searches, "query_vector": query_vector,
                          "source_order": source_order, "candidate_limit": candidate_limit,
                          "rank_options": rank_options, "before_message_id": before_message_id}
        return canned

    index = SimpleNamespace(
        client=SimpleNamespace(replace_transient=replace_transient),
        unified_query=unified_query, documents_by_id={},
    )

    @asynccontextmanager
    async def session_scope():
        yield object()

    async def get(*args, **kwargs):
        calls["prepare"] = True
        return index

    monkeypatch.setattr(br, "get_index_cache", lambda: SimpleNamespace(get=get))
    monkeypatch.setattr(embedding_mod, "is_enabled", lambda: embedding_enabled)
    monkeypatch.setattr(embedding_mod, "model_tag", lambda: model_tag)

    async def embed(text):
        return [0.1, 0.2]

    monkeypatch.setattr(embedding_mod, "embed", embed)

    async def load_memory(self, memory, scope):
        return list(memory_documents or []), "daily" if memory_documents else "", {}

    monkeypatch.setattr(UnifiedQueryRetriever, "_load_memory", load_memory)

    async def memory_vectors(self, owner, documents):
        return dict(vector_map or {})

    monkeypatch.setattr(UnifiedQueryRetriever, "_memory_vectors", memory_vectors)
    return calls, index


@pytest.mark.asyncio
async def test_unified_retriever_single_ipc_delivers_rank_rows(monkeypatch):
    """统一查询一次 IPC 完成召回+融合+排序，rank_rows 回连 Python 文档。"""
    from agent.rag.batch_retriever import UnifiedQueryRetriever
    from agent.rag.context import (
        reset_conversation_before_message_id, set_conversation_before_message_id,
    )
    from agent.rag.index_cache import _documents_fingerprint
    from agent.rag.ts_sidecar import _worker_document_key

    file_doc, memory_doc = _file_doc(), _memory_doc()
    file_key, memory_key = _worker_document_key(file_doc), _worker_document_key(memory_doc)
    canned = _canned_response(file_doc, memory_doc, file_key, memory_key)
    calls, index = _install_unified_stubs(
        monkeypatch, canned=canned, vector_map={memory_key: [0.3, 0.4]},
        memory_documents=[memory_doc])
    index.documents_by_id[file_key] = file_doc

    token = set_conversation_before_message_id(7)
    try:
        retriever = UnifiedQueryRetriever([
            _StubRetriever("synthetic-owner", "file"),
            _StubRetriever("synthetic-owner", "memory"),
        ])
        batches = await retriever.retrieve("缓存", scope=SCOPE, rank_options={"limit": 3})
    finally:
        reset_conversation_before_message_id(token)

    assert list(calls) == ["prepare", "transient", "query"]
    documents, revision, vectors, vector_version = calls["transient"]
    assert documents == [memory_doc]
    assert revision == f"{_documents_fingerprint([memory_doc])}:prov:model:2"
    assert vectors == {memory_key: [0.3, 0.4]}
    assert vector_version == "prov:model:2"

    assert calls["query"]["before_message_id"] == 7
    assert calls["query"]["query_vector"] == [0.1, 0.2]
    assert calls["query"]["source_order"] == ["memory", "file"]
    assert calls["query"]["candidate_limit"] == 20
    assert calls["query"]["rank_options"]["limit"] == 3
    assert [spec.get("corpus") for spec in calls["query"]["searches"]] == [None, "transient"]

    assert len(batches) == 1
    batch = batches[0]
    assert batch.source_type == "unified"
    assert batch.fallback_reason is None
    assert batch.candidate_count == 2
    assert batch.metadata["engine"] == "typescript"
    assert batch.metadata["unified_query"] == "True"
    assert batch.rank_stats["candidate_count"] == 2
    assert len(batch.rank_rows) == 2
    candidate, text, row = batch.rank_rows[0]
    assert candidate.document is file_doc
    assert candidate.raw_score == 1.5
    assert text == file_doc.content
    assert row["confidence"] == 0.9
    memory_candidate = batch.rank_rows[1][0]
    assert memory_candidate.document is memory_doc


@pytest.mark.asyncio
async def test_unified_retriever_fallback_labels_follow_python_facts(monkeypatch):
    """fallback 标签按 Python 侧事实判定：关闭=embedding_disabled，其余采纳 worker 回报。"""
    from agent.rag.batch_retriever import UnifiedQueryRetriever

    file_doc = _file_doc()
    file_key = "file:file-1:0"
    cases = [
        (False, None, "embedding_disabled"),
        (True, "embedding_cache_unavailable", "embedding_cache_unavailable"),
        (True, None, None),
    ]
    retriever = UnifiedQueryRetriever([_StubRetriever("synthetic-owner", "file")])
    for enabled, worker_fallback, expected in cases:
        canned = _canned_response(file_doc, _memory_doc(), file_key, "memory:daily-1:0",
                                  fallback=worker_fallback)
        calls, _index = _install_unified_stubs(monkeypatch, canned=canned,
                                               embedding_enabled=enabled)
        batches = await retriever.retrieve("缓存", scope=SCOPE)
        assert batches[0].fallback_reason == expected, (enabled, worker_fallback)
        if not enabled:
            # 无 memory 来源：核心契约是查询向量不下发，也不触发融合。
            assert calls["query"]["query_vector"] == []


def _pre_ranked_batch(triples, *, metadata=None):
    return RetrievalBatch(
        source_type="unified", rank_rows=tuple(triples), rank_stats={
            "candidate_count": len(triples), "accepted_count": len(triples),
            "top_confidence": 0.9, "threshold": 0.35, "preferred_threshold": 0.55,
            "selection_mode": "confidence", "scoring_version": "confidence-v1",
            "elapsed_ms": 2,
        },
        metadata=metadata or {"engine": "typescript", "cache_hit": "True",
                              "retrieve_ms": "5", "fusion": "hybrid-rrf"},
        candidate_count=len(triples), index_source="persistent-ts",
    )


def _triple(document, *, text=None):
    row = _selected_row(document, "unused", confidence=0.9)
    candidate = RecallCandidate.from_result(RecallResult(document, 1.5), rank=1)
    return (candidate, text or document.content, row)


@pytest.mark.asyncio
async def test_service_assembles_pre_ranked_result():
    """统一查询主链：service 跳过二次排序，直接装配 worker 已排序结果。"""
    from agent.rag.service import UnifiedRecallService

    file_doc = _file_doc()
    batch = _pre_ranked_batch([_triple(file_doc)])

    async def retrieve(query, **kwargs):
        return [batch]

    response = await UnifiedRecallService(SimpleNamespace(retrieve=retrieve)).search(
        "缓存", scope=SCOPE)
    assert response["engine"] == "typescript"
    assert response["sources"] == ["unified"]
    assert response["strategy"] == "hybrid"
    assert response["accepted_count"] == 1
    assert response["permission_rejected"] == 0
    assert response["cache_entries"] == 1
    assert response["sidecar_reused"] is None
    assert response["stage_ms"]["unified.retrieve_ms"] == 5
    assert response["source_diagnostics"]["unified"]["engine"] == "typescript"
    item = response["results"][0]
    assert item["text"] == file_doc.content
    assert item["confidence"] == 0.9
    assert item["citation"] == {"chunk_id": file_doc.chunk_id}
    assert item["citations"] == [{"chunk_id": file_doc.chunk_id}]


@pytest.mark.asyncio
async def test_service_pre_ranked_permission_recheck_drops_foreign_scope():
    """预排序装配保留第二道权限防线：越权候选从交付行剔除且不回补预算。"""
    from agent.rag.service import UnifiedRecallService

    owned, foreign = _file_doc(), IndexDocument(
        "file-2", "file", "2", Scope("other-owner"), "文件", "", "越权正文", "1")
    batch = _pre_ranked_batch([_triple(owned), _triple(foreign)])

    async def retrieve(query, **kwargs):
        return [batch]

    response = await UnifiedRecallService(SimpleNamespace(retrieve=retrieve)).search(
        "缓存", scope=SCOPE)
    assert response["permission_rejected"] == 1
    assert [item["text"] for item in response["results"]] == [owned.content]
    assert response["has_more"] is True
