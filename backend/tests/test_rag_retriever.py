import pytest

from agent.rag.adapters.projects import ProjectAdapter
from agent.rag.models import IndexDocument, RecallResult, Scope
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.service import UnifiedRecallService
from agent.rag.scope import group_scope, owner_scope
from app.models import Project


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


class _MixedScopeRetriever:
    source_type = "mixed"

    async def retrieve(self, query, *, scope, strategy, candidate_limit):
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(
                RecallResult(IndexDocument(
                    document_id=f"mixed:{owner}", source_type="memory",
                    source_id=owner, scope=Scope(owner_user_id=owner),
                    title=owner, summary="", content=f"内容 {owner}", version="v1",
                ), 1.0)
                for owner in ("user-a", "user-b")
            ),
            candidate_count=2,
        )


@pytest.mark.asyncio
async def test_recall_service_applies_scope_filter_before_selection():
    result = await UnifiedRecallService(
        UnifiedRetriever([_MixedScopeRetriever()])
    ).search("内容", scope=owner_scope("user-a"), strategy="bm25", limit=10)

    assert [item["source_id"] for item in result["results"]] == ["user-a"]
    assert result["permission_rejected"] == 1


@pytest.mark.asyncio
async def test_project_adapter_is_owner_only_and_keeps_project_citation(db, user_a):
    project = Project(
        user_id=user_a.id, name="上线计划", client="小北",
        status="active", progress=40, current_stage="验收", version=2,
    )
    project.stages = [{"name": "设计"}, {"name": "验收"}]
    db.add(project)
    await db.commit()

    adapter = ProjectAdapter(user_a.id, db=db)
    documents = await adapter.build_documents(scope=owner_scope(user_a.id))
    assert len(documents) == 1
    assert documents[0].source_type == "project"
    assert documents[0].source_id == str(project.id)
    assert "上线计划" in documents[0].content
    assert "验收" in documents[0].content
    assert await adapter.build_documents(
        scope=group_scope(user_a.id, "qq", "bot", "group")
    ) == []


class _ManyProjects:
    source_type = "project"

    async def retrieve(self, query, *, scope, strategy, candidate_limit):
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(
                RecallResult(IndexDocument(
                    document_id=f"project:{index}", source_type="project",
                    source_id=str(index), scope=Scope(owner_user_id="user-a"),
                    title=f"项目 {index}", summary="", content=f"项目内容 {index}",
                    version="v1",
                ), 100 - index)
                for index in range(8)
            ),
            candidate_count=8,
        )


@pytest.mark.asyncio
async def test_recall_service_limits_by_source_type_not_source_id():
    result = await UnifiedRecallService(
        UnifiedRetriever([_ManyProjects()])
    ).search("项目", strategy="bm25", limit=10)

    assert len(result["results"]) == 3
    assert {item["source"] for item in result["results"]} == {"project"}


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
            index_version="memory-rag-v1", mode="passive", engine="typescript",
            cache_hit=True, cache_entries=1,
        )
    finally:
        state._scope_run.reset(token)

    span = run.spans[0]
    assert span.kind == "rag"
    assert span.name == "Knowledge RAG recall"
    assert span.attributes["mode"] == "passive"
    assert span.attributes["engine"] == "typescript"
    assert span.attributes["cache_hit"] is True
    assert span.attributes["cache_entries"] == 1
    assert span.output["hit_count"] == 3
    assert "query" not in str(span.payload())
