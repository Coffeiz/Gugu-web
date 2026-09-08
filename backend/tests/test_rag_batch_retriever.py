from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from agent.rag.adapters.indexed_sources import IndexedSourceRetriever
from agent.rag.batch_retriever import BatchUnifiedRetriever
from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.ts_sidecar import SidecarRequestTiming


@pytest.mark.asyncio
async def test_persistent_sources_prepare_once_and_keep_watermark(monkeypatch):
    """多个持久化来源只准备一次索引，批量后仍按当前消息水位过滤。"""
    from agent.rag.context import set_conversation_before_message_id, reset_conversation_before_message_id
    calls = []
    scope = Scope("synthetic-owner")
    file = IndexDocument("file:1", "file", "1", scope, "文件", "", "缓存", "1")
    message = IndexDocument("conversation:12", "conversation", "12", scope, "会话", "", "缓存", "1",
                            metadata={"kind": "message", "message_id": 12})
    @asynccontextmanager
    async def session(self):
        yield object()
    async def batch(query, specs, extra_documents=None):
        calls.append("batch")
        assert len(specs) == 2
        return [([RecallResult(file, 1)], {}), ([RecallResult(message, 1)], {})], {"file": 1, "conversation": 1}, SidecarRequestTiming()
    async def get(*args, **kwargs):
        calls.append("prepare")
        return SimpleNamespace(batch_search=batch)
    monkeypatch.setattr(IndexedSourceRetriever, "session_scope", session)
    monkeypatch.setattr("agent.rag.batch_retriever.get_index_cache", lambda: SimpleNamespace(get=get))
    token = set_conversation_before_message_id(12)
    try:
        retriever = BatchUnifiedRetriever([IndexedSourceRetriever("synthetic-owner", source_type=source)
                                           for source in ("file", "conversation")])
        batches = await retriever.retrieve("缓存", scope=scope)
        assert calls == ["prepare", "batch"]
        assert batches[0].results[0].document == file
        assert not batches[1].results
    finally:
        reset_conversation_before_message_id(token)


class _StubRetriever:
    """带可编程结果的来源桩；只满足 SourceRetriever 协议与批量路径的属性访问。"""

    def __init__(self, user_id, source_type, results=()):
        self.user_id = user_id
        self.source_type = source_type
        self.source_filter = None
        self.results = tuple(results)

    @asynccontextmanager
    async def session_scope(self):
        yield object()

    async def retrieve(self, query, *, scope, strategy, candidate_limit):
        from agent.rag.retriever import RetrievalBatch
        return RetrievalBatch(source_type=self.source_type, results=self.results,
                              candidate_count=len(self.results))


@pytest.mark.asyncio
async def test_memory_joins_single_batch_ipc_with_transient_corpus(monkeypatch):
    """Memory 装入瞬态语料槽并与持久化来源共用一次索引准备和一次批量查询。"""
    from agent.rag import batch_retriever as br
    from agent.rag import service as rag_service

    calls = []
    scope = Scope("synthetic-owner")
    memory_doc = IndexDocument("memory:daily-1", "memory", "daily", scope, "记忆", "", "缓存记忆", "v1")
    file_doc = IndexDocument("file:1", "file", "1", scope, "文件", "", "缓存文件", "1")

    async def fake_recall_documents(user_id, scope, source_filter):
        return [memory_doc], "daily", {"document_load_ms": 1}

    async def fake_replace_transient(documents, revision):
        calls.append(("transient", revision))

    async def batch(query, specs, extra_documents=None):
        assert any(spec.get("corpus") == "transient" for spec in specs)
        assert extra_documents
        calls.append(("batch", [sorted(spec["source_types"]) for spec in specs],
                      [spec.get("corpus") for spec in specs]))
        hits = []
        for spec in specs:
            source = next(iter(spec["source_types"]))
            doc = file_doc if source == "file" else memory_doc
            hits.append(([RecallResult(doc, 1.0)], {}))
        return hits, {"file": 1, "memory": 1}, SidecarRequestTiming()

    async def get(*args, **kwargs):
        calls.append("prepare")
        return SimpleNamespace(batch_search=batch,
                               client=SimpleNamespace(replace_transient=fake_replace_transient))

    monkeypatch.setattr(rag_service, "_memory_recall_documents", fake_recall_documents)
    monkeypatch.setattr(br, "get_index_cache", lambda: SimpleNamespace(get=get))
    retriever = BatchUnifiedRetriever([
        _StubRetriever("synthetic-owner", "file"), _StubRetriever("synthetic-owner", "memory"),
    ])
    batches = await retriever.retrieve("缓存", scope=scope)
    kinds = [call[0] if isinstance(call, tuple) else call for call in calls]
    assert kinds == ["prepare", "transient", "batch"]
    batch_call = calls[-1]
    assert batch_call[1] == [["file"], ["memory"]]
    assert batch_call[2] == [None, "transient"]
    memory_batch = next(item for item in batches if item.source_type == "memory")
    file_batch = next(item for item in batches if item.source_type == "file")
    assert memory_batch.results[0].document.source_id == "daily"
    assert memory_batch.metadata["corpus"] == "transient"
    assert memory_batch.metadata["batch_search"] == "True"
    assert file_batch.results[0].document.source_id == "1"
    assert file_batch.metadata["batch_search"] == "True"


@pytest.mark.asyncio
async def test_memory_only_query_falls_back_to_legacy(monkeypatch):
    """只有 Memory 来源的显式查询退回 legacy 瞬态索引路径，不触碰批量索引。"""
    from agent.rag import batch_retriever as br

    def _forbidden(*args, **kwargs):
        raise AssertionError("memory-only 查询不应准备批量索引")

    monkeypatch.setattr(br, "get_index_cache", _forbidden)
    retriever = BatchUnifiedRetriever([_StubRetriever("synthetic-owner", "memory")])
    batches = await retriever.retrieve("缓存", scope=Scope("synthetic-owner"))
    assert [item.source_type for item in batches] == ["memory"]


def test_persistent_specs_scope_matrix():
    """file/canvas/note/project 各自允许的 scope 类型被正确收口。"""
    owner = Scope("synthetic-owner")
    project = Scope("synthetic-owner", scope_type="project", scope_id="p1")
    folder = Scope("synthetic-owner", scope_type="folder", scope_id="f1")
    group = Scope("synthetic-owner", scope_type="group", scope_id="g1")
    stubs = [_StubRetriever("synthetic-owner", name)
             for name in ("file", "canvas", "note", "conversation")]
    specs, allowed = BatchUnifiedRetriever([])._persistent_specs(
        stubs, [owner, project, folder, group], limit=5)
    by_source = {}
    for spec in specs:
        by_source.setdefault(next(iter(spec["source_types"])), []).append(spec["scope"].scope_type)
    assert sorted(by_source["file"]) == ["folder", "owner", "project"]
    assert sorted(by_source["canvas"]) == ["owner", "project"]
    assert by_source["note"] == ["owner"]
    assert sorted(by_source["conversation"]) == ["folder", "group", "owner", "project"]
    assert allowed["note"] == [owner]
    assert all(spec["limit"] == 5 for spec in specs)


@pytest.mark.asyncio
async def test_shadow_mode_delivers_legacy_and_records_diff():
    """batch_shadow 交付 legacy 结果，候选差异统计写入批次元数据。"""
    from agent.rag.batch_retriever import ShadowUnifiedRetriever
    from agent.rag.retriever import RetrievalBatch

    scope = Scope("synthetic-owner")
    legacy_doc = IndexDocument("file:1", "file", "1", scope, "文件", "", "缓存", "1")
    batch_doc = IndexDocument("file:2", "file", "2", scope, "文件", "", "缓存", "1")
    retriever = ShadowUnifiedRetriever(
        [_StubRetriever("synthetic-owner", "file", [RecallResult(legacy_doc, 1.0)])])

    class _ShadowStub:
        async def retrieve(self, query, **kwargs):
            return [RetrievalBatch(source_type="file",
                                   results=(RecallResult(batch_doc, 0.5),), candidate_count=1)]

    retriever._batch = _ShadowStub()
    batches = await retriever.retrieve("缓存", scope=scope)
    assert batches[0].results[0].document.chunk_id == legacy_doc.chunk_id
    assert batches[0].metadata["shadow_mode"] == "batch"
    assert batches[0].metadata["shadow_equal"] == "False"
    assert batches[0].metadata["shadow_first_diff_index"] == "0"
    assert batches[0].metadata["shadow_batch_count"] == "1"
    assert int(batches[0].metadata["shadow_total_ms"]) >= 0


@pytest.mark.asyncio
async def test_shadow_mode_reports_equality_when_candidates_match():
    """批量与 legacy 候选完全一致时 shadow_equal=True，不报差异位置。"""
    from agent.rag.batch_retriever import ShadowUnifiedRetriever
    from agent.rag.retriever import RetrievalBatch

    scope = Scope("synthetic-owner")
    doc = IndexDocument("file:1", "file", "1", scope, "文件", "", "缓存", "1")
    retriever = ShadowUnifiedRetriever(
        [_StubRetriever("synthetic-owner", "file", [RecallResult(doc, 1.0)])])

    class _ShadowStub:
        async def retrieve(self, query, **kwargs):
            return [RetrievalBatch(source_type="file", results=(RecallResult(doc, 1.0),),
                                   candidate_count=1)]

    retriever._batch = _ShadowStub()
    batches = await retriever.retrieve("缓存", scope=scope)
    assert batches[0].metadata["shadow_equal"] == "True"
    assert batches[0].metadata["shadow_first_diff_index"] == ""
