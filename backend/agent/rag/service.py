"""Knowledge RAG 统一召回服务与 Memory 首个来源实现。"""
from __future__ import annotations

import re
import time
from dataclasses import replace

from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.adapters.projects import ProjectAdapter
from agent.rag.adapters.knowledge import KnowledgeAdapter
from agent.rag.context import get_snapshot_context
from agent.rag.diagnostics import record_recall
from agent.rag.hybrid import hybrid_results
from agent.rag.models import RecallCandidate, RecallResult, Scope
from agent.rag.persistent_store import load_index_documents, replace_source_documents, search_persistent_index
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.scoring import filter_confidence, normalize_scores, token_similarity
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.rust_sidecar import RustSidecarUnavailable
from agent.rag.scope import filter_authorized_documents, matches_scope, normalize_memory_scope
from agent.rag.storage import PersistentMemoryIndex
from agent.rag.vector_cache import cache_key


MAX_ACTIVE_RESULTS = 10
DEFAULT_RESULTS = 5
MAX_OUTPUT_CHARS = 3000
MAX_PER_SOURCE = 3
SOURCE_PRIORITY = {
    "memory": 0,
    "project": 10,
    "file": 20,
    "journal": 30,
    "canvas": 40,
    "conversation": 50,
}


def _snapshot_covers_document(text: str, snapshot_text: str) -> bool:
    """判断 chunk 是否已经被当前 snapshot 注入，避免工具结果重复占上下文。"""
    normalized = re.sub(r"\s+", "", (text or "").strip())
    snapshot = re.sub(r"\s+", "", snapshot_text or "")
    if not normalized or not snapshot:
        return False
    if normalized in snapshot:
        return True
    # snapshot 可能只包含了超长 chunk 的前半段；只有覆盖了大部分内容才排除，
    # 避免把仅因 chunk overlap 而重复的少量前缀误判成已完整注入。
    minimum = max(80, int(len(normalized) * 0.7))
    return any(normalized[:size] in snapshot for size in range(len(normalized), minimum - 1, -1))


async def _load_memory_documents(user_id, query_scope):
    """优先读取持久化索引；缺失时重建一次并尽力回填。"""
    if query_scope.scope_type != "owner":
        return await MemoryAdapter(user_id).build_documents(scope=query_scope), "scope-rebuild"
    index = PersistentMemoryIndex(user_id)
    documents = await index.load()
    if documents is not None:
        # daily 是高频追加来源，事件索引更新是异步的；查询时只刷新 daily，
        # 避免在反思刚写完、RAG 事件尚未完成时继续命中旧持久索引。
        adapter = MemoryAdapter(user_id)
        fresh_daily = await adapter.build_daily_documents(scope=query_scope)
        documents = [document for document in documents if document.source_id != "daily"]
        documents.extend(fresh_daily)
        return documents, "persistent+daily-refresh"
    documents = await MemoryAdapter(user_id).build_documents(scope=query_scope)
    try:
        await index.replace(documents)
    except Exception:
        # 索引是可重建缓存，落盘失败不阻塞本轮主动查询。
        pass
    return documents, "rebuild"


class MemoryRetriever:
    """Memory 来源的候选召回器；最终结果预算由 UnifiedRecallService 负责。"""

    source_type = "memory"

    def __init__(self, user_id, *, source_filter: str = "all"):
        self.user_id = user_id
        self.source_filter = source_filter

    async def retrieve(
        self,
        query: str,
        *,
        scope,
        strategy: str,
        candidate_limit: int,
    ) -> RetrievalBatch:
        query_scope = normalize_memory_scope(self.user_id, scope)
        documents, index_source = await _load_memory_documents(self.user_id, query_scope)
        allowed_sources = {"profile", "pattern", "daily", "memory"}
        if self.source_filter != "all":
            allowed_sources &= {self.source_filter}
        documents = [
            doc for doc in documents
            if doc.source_id in allowed_sources and matches_scope(doc, query_scope)
        ]
        snapshot_text = get_snapshot_context()
        if snapshot_text:
            documents = [
                doc for doc in documents
                if not _snapshot_covers_document(doc.content, snapshot_text)
            ]

        search_metadata: dict[str, object] = {}
        try:
            lexical = await search_documents_with_cache(
                self.user_id, documents, query, limit=candidate_limit,
                diagnostics=search_metadata,
            )
        except RustSidecarUnavailable:
            from agent.rag.legacy_lexical import LegacyBM25

            lexical = LegacyBM25(documents).search(query, limit=candidate_limit)
            search_metadata.update({"engine": "python", "cache_hit": False,
                                    "fallback": "rust_sidecar_unavailable"})
        final: list[RecallResult] = lexical
        fusion = "bm25"
        fallback_reason = "embedding_disabled"
        if not lexical:
            fallback_reason = "lexical_empty"
        if strategy in {"auto", "embedding"}:
            from agent.memory import embedding

            if embedding.is_enabled():
                query_vector = await embedding.embed(query)
                vector_map = await _load_cached_vectors(self.user_id, documents)
                final, fallback_reason = hybrid_results(
                    lexical, documents, query_vector, vector_map, limit=candidate_limit
                )
                if fallback_reason is None:
                    fusion = "hybrid-rrf"
            elif strategy == "embedding":
                fallback_reason = "embedding_disabled"
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("strategy 只能是 auto、bm25 或 embedding")
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(final),
            index_source=index_source,
            fallback_reason=fallback_reason,
            candidate_count=len(documents),
            metadata={
                **{key: str(value) for key, value in search_metadata.items()},
                "fusion": fusion,
            },
        )


class ProjectRetriever:
    """Project 来源候选召回器；词法检索由 Rust sidecar 执行。"""

    source_type = "project"

    def __init__(self, user_id, *, db=None):
        self.adapter = ProjectAdapter(user_id, db=db)

    async def retrieve(
        self,
        query: str,
        *,
        scope,
        strategy: str,
        candidate_limit: int,
    ) -> RetrievalBatch:
        query_scope = normalize_memory_scope(self.adapter.user_id, scope)
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("strategy 只能是 auto、bm25 或 embedding")
        if self.adapter._db is not None:
            search_metadata: dict[str, object] = {}
            results = await self._search_db(
                self.adapter._db, query, query_scope, candidate_limit,
                diagnostics=search_metadata,
            )
            candidate_count = len(await load_index_documents(
                self.adapter._db, self.adapter.user_id, source_types={self.source_type},
            ))
            return RetrievalBatch(
                source_type=self.source_type,
                results=tuple(results),
                index_source="knowledge-index-db",
                fallback_reason="embedding_disabled",
                candidate_count=candidate_count,
                metadata={
                    **{key: str(value) for key, value in search_metadata.items()},
                    "fusion": "bm25",
                },
            )
        documents = await self.adapter.build_documents(scope=query_scope)
        search_metadata = {}
        try:
            results = await search_documents_with_cache(
                self.adapter.user_id, documents, query, limit=candidate_limit,
                diagnostics=search_metadata,
            )
        except RustSidecarUnavailable:
            from agent.rag.legacy_lexical import LegacyBM25

            results = LegacyBM25(documents).search(query, limit=candidate_limit)
            search_metadata.update({"engine": "python", "cache_hit": False,
                                    "fallback": "rust_sidecar_unavailable"})
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(results),
            index_source="projects-db",
            fallback_reason="embedding_disabled",
            candidate_count=len(documents),
            metadata={
                **{key: str(value) for key, value in search_metadata.items()},
                "fusion": "bm25",
            },
        )

    async def _search_db(self, db, query: str, scope, limit: int,
                         diagnostics: dict[str, object] | None = None):
        documents = await load_index_documents(
            db, self.adapter.user_id, source_types={self.source_type},
        )
        if not documents:
            documents = await self.adapter.build_documents(scope=scope)
            await replace_source_documents(db, self.adapter.user_id, self.source_type, documents)
            await db.commit()
        try:
            return await search_persistent_index(
                db, self.adapter.user_id, query,
                source_types={self.source_type}, scope=scope, limit=limit,
                diagnostics=diagnostics,
            )
        except RustSidecarUnavailable:
            from agent.rag.legacy_lexical import LegacyBM25

            scoped_documents = [document for document in documents if matches_scope(document, scope)]
            if diagnostics is not None:
                diagnostics.update({"engine": "python", "cache_hit": False,
                                    "fallback": "rust_sidecar_unavailable"})
            return LegacyBM25(scoped_documents).search(query, limit=limit)


class UnifiedRecallService:
    """跨来源召回编排：scope-first、去重、引用和最终上下文预算只做一份。"""

    def __init__(self, retriever: UnifiedRetriever):
        self.retriever = retriever

    async def search(
        self,
        query: str,
        *,
        source: str = "all",
        scope: str = "auto",
        strategy: str = "auto",
        limit: int = DEFAULT_RESULTS,
    ) -> dict:
        requested_limit = max(1, min(int(limit or DEFAULT_RESULTS), MAX_ACTIVE_RESULTS))
        batches = await self.retriever.retrieve(
            query,
            source=source,
            scope=scope,
            strategy=strategy,
            candidate_limit=20,
        )
        batch_order = {batch.source_type: index for index, batch in enumerate(batches)}
        candidates: list[tuple[int, RecallCandidate]] = []
        for batch in batches:
            batch_candidates = normalize_scores(list(batch.candidates()))
            fusion = batch.metadata.get("fusion")
            batch_candidates = [
                replace(
                    candidate,
                    fused_score=(
                        candidate.raw_score
                        if fusion == "hybrid-rrf"
                        else candidate.normalized_score
                    ),
                )
                for candidate in batch_candidates
            ]
            candidates.extend(
                (batch_order.get(batch.source_type, 999), candidate)
                for candidate in batch_candidates
            )
        # 来源 adapter 已执行 scope-first；这里再做一次统一边界校验，防止
        # 新来源遗漏 owner/group/member 过滤后把越权候选带入融合。
        permission_rejected = 0
        if isinstance(scope, Scope):
            authorized: list[tuple[int, RecallCandidate]] = []
            for order, candidate in candidates:
                allowed, rejected = filter_authorized_documents(
                    [candidate.document], scope,
                )
                if rejected:
                    permission_rejected += rejected
                    continue
                authorized.append((order, candidate))
            candidates = authorized
        # Phase 2 后统一使用 fused_score 跨来源排序；来源优先级、更新时间和
        # chunk id 只作为同分时的稳定 tie-breaker。稳定排序顺序不能拆到调用方。
        candidates.sort(key=lambda item: SOURCE_PRIORITY.get(
            item[1].document.source_type, 100 + item[0]
        ))
        candidates.sort(key=lambda item: item[1].document.chunk_id)
        candidates.sort(key=lambda item: item[1].document.updated_at or "", reverse=True)
        candidates.sort(key=lambda item: item[1].fused_score, reverse=True)
        scored_candidates, score_stats = filter_confidence(
            query, [candidate for _, candidate in candidates], limit=requested_limit,
        )
        accepted = {
            (candidate.source_type, candidate.document.chunk_id)
            for candidate in scored_candidates
        }
        candidates = [
            item for item in candidates
            if (item[1].source_type, item[1].document.chunk_id) in accepted
        ]
        scored_by_key = {
            (candidate.source_type, candidate.document.chunk_id): candidate
            for candidate in scored_candidates
        }
        candidates = [
            (order, scored_by_key[(candidate.source_type, candidate.document.chunk_id)])
            for order, candidate in candidates
        ]
        candidates.sort(key=lambda item: item[1].fused_score, reverse=True)

        # 同一正文从多个来源返回时只占一份预算；引用合并由下面保留的 public item 表达。
        selected: list[dict] = []
        selected_candidates: list[RecallCandidate] = []
        by_hash: dict[str, dict] = {}
        used_sources: dict[str, int] = {}
        used_parents: dict[str, int] = {}
        rejected_duplicate = 0
        rejected_parent = 0
        rejected_source = 0
        rejected_diversity = 0
        output_chars = 0
        for _, candidate in candidates:
            document = candidate.document
            public_item = candidate.as_public()
            content_key = document.content_hash
            existing = by_hash.get(content_key)
            if existing is not None:
                rejected_duplicate += 1
                citation = public_item.get("citation")
                if citation and citation not in existing.setdefault("citations", []):
                    existing["citations"].append(citation)
                continue
            parent = document.parent_document_id or document.document_id
            if used_parents.get(parent, 0) >= 3:
                rejected_parent += 1
                continue
            if used_sources.get(document.source_type, 0) >= MAX_PER_SOURCE:
                rejected_source += 1
                continue
            if any(token_similarity(candidate, previous) >= 0.85 for previous in selected_candidates):
                rejected_diversity += 1
                continue
            remaining = MAX_OUTPUT_CHARS - output_chars
            if remaining <= 0:
                break
            if len(public_item["text"]) > remaining:
                if selected:
                    break
                public_item = {**public_item, "text": public_item["text"][:remaining].rstrip()}
            if not public_item["text"]:
                continue
            public_item["citations"] = [public_item["citation"]]
            selected.append(public_item)
            selected_candidates.append(candidate)
            by_hash[content_key] = public_item
            used_sources[document.source_type] = used_sources.get(document.source_type, 0) + 1
            used_parents[parent] = used_parents.get(parent, 0) + 1
            output_chars += len(public_item["text"])
            if len(selected) >= requested_limit:
                break

        fallback_reasons = [batch.fallback_reason for batch in batches if batch.fallback_reason]
        engines = {batch.metadata.get("engine") for batch in batches if batch.metadata.get("engine")}
        cache_values = [batch.metadata.get("cache_hit") == "True" for batch in batches
                        if "cache_hit" in batch.metadata]
        cache_miss_reasons = sorted({
            reason
            for batch in batches
            for reason in (
                batch.metadata.get("cache_miss_reasons")
                or batch.metadata.get("cache_miss_reason")
                or ""
            ).split(",")
            if reason
        })
        return {
            "query": query,
            "results": selected,
            "has_more": len(candidates) > len(selected),
            "strategy": "hybrid" if batches and not all(fallback_reasons) else "bm25",
            "fallback_reason": fallback_reasons[0] if fallback_reasons else None,
            "index_source": ",".join(sorted({batch.index_source for batch in batches})),
            "sources": sorted({batch.source_type for batch in batches}),
            "candidate_count": sum(batch.candidate_count for batch in batches),
            "permission_rejected": permission_rejected,
            "rejected_low_score": score_stats["rejected_low_score"],
            "rejected_not_preferred": score_stats["rejected_not_preferred"],
            "rejected_duplicate": rejected_duplicate,
            "rejected_parent": rejected_parent,
            "rejected_source": rejected_source,
            "rejected_diversity": rejected_diversity,
            "accepted_count": len(selected),
            "top_confidence": score_stats["top_confidence"],
            "confidence_threshold": score_stats["threshold"],
            "preferred_confidence_threshold": score_stats["preferred_threshold"],
            "scoring_version": score_stats["scoring_version"],
            "engine": next(iter(engines)) if len(engines) == 1 else ("mixed" if engines else "unknown"),
            "cache_hit": bool(cache_values) and all(cache_values),
            "cache_entries": sum(int(batch.metadata.get("cache_entries", "0")) for batch in batches),
            "cache_miss_reasons": cache_miss_reasons,
        }


async def search_memory(
    user_id, query: str, *, scope="auto", source: str = "all", strategy: str = "auto", limit: int = DEFAULT_RESULTS,
    mode: str = "tool",
) -> dict:
    started = time.monotonic()
    query = (query or "").strip()
    if not query:
        return {"query": "", "results": [], "has_more": False, "message": "需要提供检索关键词"}
    retrievers = []
    if source in {"all", "profile", "pattern", "daily", "memory"}:
        retrievers.append(MemoryRetriever(user_id, source_filter=source if source != "knowledge" else "all"))
    if source in {"all", "knowledge"}:
        retrievers.append(KnowledgeAdapter(user_id))
    service = UnifiedRecallService(UnifiedRetriever(retrievers))
    result = await service.search(
        query, source="all" if source == "all" else source,
        scope=scope,
        strategy=strategy,
        limit=limit,
    )
    record_recall(
        namespace="knowledge",
        source_type="memory",
        candidate_count=result.get("candidate_count", 0),
        hit_count=len(result["results"]),
        elapsed_ms=int((time.monotonic() - started) * 1000),
        fallback_reason=result.get("fallback_reason"),
        index_version="memory-rag-v1",
        mode=mode,
        scope_type=getattr(scope, "scope_type", "owner"),
        scope_key=getattr(scope, "key", lambda: "")() if hasattr(scope, "key") else "",
        injected=bool(result.get("results")),
        engine=result.get("engine", "unknown"),
        cache_hit=result.get("cache_hit"),
        cache_entries=result.get("cache_entries"),
        cache_miss_reasons=result.get("cache_miss_reasons"),
        quality={
            key: result.get(key)
            for key in (
                "accepted_count", "rejected_low_score", "rejected_not_preferred",
                "rejected_duplicate", "rejected_parent", "rejected_source",
                "rejected_diversity", "top_confidence", "confidence_threshold",
                "preferred_confidence_threshold", "scoring_version",
            )
            if result.get(key) is not None
        },
    )
    return result


async def search_knowledge(
    user_id, query: str, *, scope="auto", source: str = "all", strategy: str = "bm25",
    limit: int = DEFAULT_RESULTS, mode: str = "automatic", db=None,
) -> dict:
    """统一 Knowledge 入口：当前阶段注册 Memory 与 Project 两个来源。

    `search_memory` 保持记忆专用工具语义；自动召回和后续跨来源入口使用本函数。
    """
    started = time.monotonic()
    query = (query or "").strip()
    if not query:
        return {"query": "", "results": [], "has_more": False, "message": "需要提供检索关键词"}
    if db is None:
        # Web/IM 的自动召回通常没有沿调用链携带 DB session；在这里短暂打开一份，
        # 让 Project 等数据库来源也能复用持久化 Rust lexical 索引。
        import app.db.session as db_session
        # 统一走 ensure_engine，处理跨事件循环和 reset_engine 的生命周期，
        # 不要直接读取 _engine 再调用私有构造函数。
        db_session.ensure_engine()
        session_factory = db_session._SessionLocal
        if session_factory is None:
            raise RuntimeError("RAG 数据库会话工厂未初始化")
        async with session_factory() as search_db:
            return await search_knowledge(
                user_id, query, scope=scope, source=source, strategy=strategy,
                limit=limit, mode=mode, db=search_db,
            )
    service = UnifiedRecallService(UnifiedRetriever([
        MemoryRetriever(user_id),
        KnowledgeAdapter(user_id),
        ProjectRetriever(user_id, db=db),
    ]))
    result = await service.search(
        query, source=source, scope=scope, strategy=strategy, limit=limit,
    )
    record_recall(
        namespace="knowledge", source_type="all" if source == "all" else source,
        candidate_count=result.get("candidate_count", 0), hit_count=len(result["results"]),
        elapsed_ms=int((time.monotonic() - started) * 1000),
        fallback_reason=result.get("fallback_reason"),
        index_version="knowledge-rag-v1", mode=mode,
        scope_type=getattr(scope, "scope_type", "owner"),
        scope_key=getattr(scope, "key", lambda: "")() if hasattr(scope, "key") else "",
        injected=bool(result.get("results")),
        engine=result.get("engine", "unknown"),
        cache_hit=result.get("cache_hit"),
        cache_entries=result.get("cache_entries"),
        cache_miss_reasons=result.get("cache_miss_reasons"),
        quality={
            key: result.get(key)
            for key in (
                "accepted_count", "rejected_low_score", "rejected_not_preferred",
                "rejected_duplicate", "rejected_parent", "rejected_source",
                "rejected_diversity", "top_confidence", "confidence_threshold",
                "preferred_confidence_threshold", "scoring_version",
            )
            if result.get(key) is not None
        },
    )
    return result


async def _load_cached_vectors(user_id, documents) -> dict[str, list[float]]:
    """读取已有 memory/pattern cache，不在查询热路径生成文档向量。"""
    from agent.memory import embedding, store

    tag = embedding.model_tag()
    pattern = await store.read_pattern_vecs(user_id)
    memory = await store.read_memory_vecs(user_id)
    result: dict[str, list[float]] = {}
    for doc in documents:
        key = doc.metadata.get("vector_key")
        if doc.source_id == "pattern":
            cached = pattern.get(key or "")
        else:
            cached = memory.get(cache_key(doc) or "")
        if cached and cached.get("t") == tag and isinstance(cached.get("v"), list):
            result[doc.chunk_id] = cached["v"]
    return result
