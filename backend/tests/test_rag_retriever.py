import asyncio
import pytest
from contextlib import asynccontextmanager

from agent.rag import service as rag_service
from agent.rag.adapters.projects import ProjectAdapter
from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.service import UnifiedRecallService
from agent.rag.scope import group_scope, owner_scope
from app.models import Project


@pytest.fixture(autouse=True)
def _mock_ts_ranker(monkeypatch):
    """服务单测隔离进程边界；完整 TS 选择算法由 Worker protocol 测试覆盖。"""
    async def rank(_owner, _query, candidates, *, limit, max_chars, max_per_source, max_per_parent):
        selected = []
        hashes = set()
        source_counts = {}
        parent_counts = {}
        output_chars = 0
        duplicate = parent = source = 0
        for candidate in candidates:
            document = candidate.document
            if document.content_hash in hashes:
                duplicate += 1
                for previous_candidate, _, rank_item in selected:
                    if previous_candidate.document.content == document.content:
                        rank_item["citations"].append(candidate.as_public()["citation"])
                        break
                continue
            parent_id = document.parent_document_id or document.document_id
            if parent_counts.get(parent_id, 0) >= max_per_parent:
                parent += 1
                continue
            if source_counts.get(document.source_type, 0) >= max_per_source:
                source += 1
                continue
            remaining = max_chars - output_chars
            if remaining <= 0:
                break
            from dataclasses import replace
            if len(document.content) > remaining:
                candidate = replace(candidate, document=replace(document, content=document.content[:remaining]))
            selected.append((candidate, candidate.document.content, {
                "confidence": 0.9, "source_quality": 0.9,
                "normalized_score": candidate.normalized_score,
                "fused_score": candidate.fused_score or candidate.raw_score,
                "citation": candidate.as_public()["citation"],
                "citations": [candidate.as_public()["citation"]],
            }))
            hashes.add(document.content_hash)
            source_counts[document.source_type] = source_counts.get(document.source_type, 0) + 1
            parent_counts[parent_id] = parent_counts.get(parent_id, 0) + 1
            output_chars += len(candidate.document.content)
            if len(selected) >= limit:
                break
        return selected, {
            "candidate_count": len(candidates), "accepted_count": len(selected),
            "rejected_duplicate": duplicate, "rejected_parent": parent,
            "rejected_source": source, "rejected_similarity": 0,
            "output_chars": output_chars, "rejected_low_score": 0,
            "rejected_not_preferred": 0, "top_confidence": 0.9,
            "threshold": 0.35, "preferred_threshold": 0.55,
            "scoring_version": "confidence-v1", "elapsed_ms": 0,
        }
    monkeypatch.setattr(rag_service, "rank_candidates_with_cache", rank)


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


@pytest.mark.asyncio
async def test_database_retrievers_use_independent_sessions_for_parallel_recall():
    """并行来源不能共享 AsyncSession，否则超时收尾会触发 SQLAlchemy 状态竞争。"""
    from agent.rag.adapters.indexed_sources import IndexedSourceRetriever

    sessions = []

    @asynccontextmanager
    async def session_factory():
        session = object()
        sessions.append(session)
        yield session

    retrievers = [
        IndexedSourceRetriever(
            "user-a", db_factory=session_factory, source_type=source_type,
        )
        for source_type in ("file", "canvas", "conversation")
    ]

    async def use_session(retriever):
        async with retriever.session_scope() as session:
            await asyncio.sleep(0)
            return session

    acquired = await asyncio.gather(*(use_session(item) for item in retrievers))
    assert len({id(session) for session in acquired}) == 3
    assert len(sessions) == 3


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


@pytest.mark.asyncio
async def test_project_adapter_accepts_db_factory(db, user_a):
    """自动召回使用独立会话工厂时，项目来源不能因旧签名而初始化失败。"""
    project = Project(user_id=user_a.id, name="工厂会话项目", status="active", version=1)
    db.add(project)
    await db.commit()

    @asynccontextmanager
    async def session_factory():
        yield db

    adapter = ProjectAdapter(user_a.id, db_factory=session_factory)
    documents = await adapter.build_documents(scope=owner_scope(user_a.id))

    assert [item.source_id for item in documents] == [str(project.id)]


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


def test_recall_diagnostics_preserves_multiple_scope_identity(monkeypatch):
    from agent.rag.diagnostics import record_recall
    from agent.rag.models import Scope
    from agent.runtime.loopscope_trace import state

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = state._ScopeRun(
        id="run-rag-multi-scope", trace_id="trace-rag-multi-scope", session_key="test",
        external_session_id="1", source="qq", started_at=state._now(),
    )
    token = state._scope_run.set(run)
    try:
        record_recall(
            namespace="knowledge", source_type="all", candidate_count=2,
            hit_count=0, elapsed_ms=3, fallback_reason="low_score",
            index_version="knowledge-rag-v1", scope_type="multi",
            scope_details=[
                {"scope_type": "group", "scope_digest": "group-digest", "candidate_count": 1},
                {"scope_type": "member", "scope_digest": "member-digest", "candidate_count": 1},
            ],
        )
    finally:
        state._scope_run.reset(token)

    span = run.spans[0]
    assert span.attributes["scope_type"] == "multi"
    assert [item["scope_type"] for item in span.attributes["scope_details"]] == [
        "group", "member",
    ]
    assert "group-digest" in str(span.payload())
    assert "member-digest" in str(span.payload())
    assert "group-1" not in str(span.payload())


def test_recall_scope_details_split_group_and_member_candidates():
    from agent.rag.service import _scope_details
    from agent.rag.scope import member_scope

    group = group_scope("user-a", "qq", "bot-1", "group-1")
    member = member_scope("user-a", "qq", "bot-1", "group-1", "member-1")
    candidates = [
        RecallCandidate.from_result(RecallResult(IndexDocument(
            "group-memory", "memory", "memory", group, "群", "", "群内容", "v1",
        ), 1.0), rank=1),
        RecallCandidate.from_result(RecallResult(IndexDocument(
            "member-memory", "memory", "memory", member, "群友", "", "群友内容", "v1",
        ), 0.9), rank=2),
    ]

    details = _scope_details([group, member], candidates, [])

    assert [(item["scope_type"], item["candidate_count"], item["selected_count"])
            for item in details] == [("group", 1, 0), ("member", 1, 0)]


def test_conversation_rag_excludes_current_message_watermark():
    from types import SimpleNamespace
    from agent.rag.adapters.indexed_sources import _conversation_document_visible

    old = SimpleNamespace(metadata={"kind": "message", "message_id": 10})
    current = SimpleNamespace(metadata={"kind": "message", "message_id": 11})
    summary = SimpleNamespace(metadata={"kind": "summary"})

    assert _conversation_document_visible(old, 11) is True
    assert _conversation_document_visible(current, 11) is False
    assert _conversation_document_visible(summary, 11) is True
