import pytest

from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.service import UnifiedRecallService


class FakeRetriever:
    source_type = "fake"

    async def retrieve(self, query, *, scope, strategy, candidate_limit):
        document = IndexDocument(
            document_id="fake:1",
            source_type=self.source_type,
            source_id=self.source_type,
            scope=Scope(owner_user_id="user-a"),
            title="测试来源",
            summary="摘要",
            content=query,
            version="v1",
        )
        return RetrievalBatch(
            source_type=self.source_type,
            results=(RecallResult(document, 1.0),),
            index_source="memory",
            candidate_count=1,
        )


class SameContentRetriever(FakeRetriever):
    source_type = "fake-duplicate"


@pytest.mark.asyncio
async def test_unified_retriever_dispatches_registered_source():
    retriever = UnifiedRetriever([FakeRetriever()])

    batches = await retriever.retrieve("缓存", source="fake", scope="owner", strategy="bm25", candidate_limit=20)

    assert retriever.sources() == ("fake",)
    assert batches[0].results[0].document.content == "缓存"


def test_unified_retriever_rejects_duplicate_source():
    with pytest.raises(ValueError, match="重复注册"):
        UnifiedRetriever([FakeRetriever(), FakeRetriever()])


@pytest.mark.asyncio
async def test_recall_service_merges_same_content_citations():
    service = UnifiedRecallService(UnifiedRetriever([FakeRetriever(), SameContentRetriever()]))

    result = await service.search("缓存", source="all", strategy="bm25", limit=10)

    assert len(result["results"]) == 1
    assert {item["source_type"] for item in result["results"][0]["citations"]} == {
        "fake", "fake-duplicate"
    }


def test_recall_diagnostics_creates_redacted_loopscope_span(monkeypatch):
    from agent.rag.diagnostics import record_recall
    from agent.runtime.loopscope_trace import state

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = state._ScopeRun(
        id="run-rag-test", trace_id="trace-rag-test", session_key="test",
        external_session_id="1", source="test", started_at=state._now(),
    )
    token = state._scope_run.set(run)
    try:
        record_recall(
            namespace="knowledge", source_type="memory", candidate_count=12,
            hit_count=3, elapsed_ms=17, fallback_reason="embedding_disabled",
            index_version="memory-rag-v1", mode="passive",
        )
    finally:
        state._scope_run.reset(token)

    span = run.spans[0]
    assert span.kind == "rag"
    assert span.name == "Knowledge RAG recall"
    assert span.attributes["mode"] == "passive"
    assert span.output["hit_count"] == 3
    assert "query" not in str(span.payload())
