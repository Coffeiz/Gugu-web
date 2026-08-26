"""Knowledge RAG 统一召回服务与 Memory 首个来源实现。"""
from __future__ import annotations

import re
import time
import uuid
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
from agent.rag.scoring import normalize_scores, token_similarity
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.ts_sidecar import TsSidecarUnavailable, score_candidates_with_cache
from agent.rag.scope import (
    matches_any_scope,
    matches_scope,
    normalize_memory_scopes,
    resolve_memory_query_scopes,
)
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
        documents, source = await MemoryAdapter(user_id).build_cached_documents(scope=query_scope)
        return documents, source
    return await MemoryAdapter(user_id).build_cached_owner_documents(scope=query_scope)


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
        query_scopes = normalize_memory_scopes(self.user_id, scope)
        import asyncio
        document_load_started = time.monotonic()
        loaded = await asyncio.gather(*[
            _load_memory_documents(self.user_id, query_scope)
            for query_scope in query_scopes
        ])
        document_load_ms = int((time.monotonic() - document_load_started) * 1000)
        documents = [document for docs, _ in loaded for document in docs]
        index_source = ",".join(sorted({source for _, source in loaded}))
        allowed_sources = {"profile", "pattern", "daily", "memory"}
        if self.source_filter != "all":
            allowed_sources &= {self.source_filter}
        documents = [
            doc for doc in documents
            if doc.source_id in allowed_sources
            and matches_any_scope(doc, query_scopes)
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
                source_types={"memory"},
                diagnostics=search_metadata,
            )
        except TsSidecarUnavailable:
            lexical = []
            search_metadata.update({"engine": "unavailable", "cache_hit": False,
                                    "fallback": "lexical_worker_unavailable"})
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
                "document_load_ms": str(document_load_ms),
                "fusion": fusion,
            },
        )


class ProjectRetriever:
    """Project 来源候选召回器；词法检索由 TypeScript worker 执行。"""

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
        query_scopes = normalize_memory_scopes(self.adapter.user_id, scope)
        query_scope = next(
            (item for item in query_scopes if item.scope_type == "owner"),
            None,
        )
        if query_scope is None:
            return RetrievalBatch(
                source_type=self.source_type,
                index_source="projects-db" if self.adapter._db is not None else "projects-store",
                fallback_reason="scope_not_supported",
                candidate_count=0,
            )
        if strategy not in {"auto", "bm25", "embedding"}:
            raise ValueError("strategy 只能是 auto、bm25 或 embedding")
        if self.adapter._db is not None:
            search_metadata: dict[str, object] = {}
            results = await self._search_db(
                self.adapter._db, query, query_scope, candidate_limit,
                diagnostics=search_metadata,
            )
            candidate_count = int(search_metadata.get("document_count", 0) or 0)
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
        from agent.rag.index_cache import get_index_cache
        load_started = time.monotonic()
        documents = await get_index_cache().get_snapshot_documents(
            self.adapter.user_id,
            f"project:{query_scope.key()}",
            lambda: self.adapter.build_documents(scope=query_scope),
        )
        search_metadata = {}
        try:
            results = await search_documents_with_cache(
                self.adapter.user_id, documents, query, limit=candidate_limit,
                source_types={"project"}, scope=query_scope,
                diagnostics=search_metadata,
            )
        except TsSidecarUnavailable:
            results = []
            search_metadata.update({"engine": "unavailable", "cache_hit": False,
                                    "fallback": "lexical_worker_unavailable"})
        return RetrievalBatch(
            source_type=self.source_type,
            results=tuple(results),
            index_source="projects-db",
            fallback_reason="embedding_disabled",
            candidate_count=len(documents),
            metadata={
                **{key: str(value) for key, value in search_metadata.items()},
                "document_load_ms": str(int((time.monotonic() - load_started) * 1000)),
                "fusion": "bm25",
            },
        )

    async def _search_db(self, db, query: str, scope, limit: int,
                         diagnostics: dict[str, object] | None = None):
        from agent.rag.context import get_snapshot_revision

        # snapshot-bound index 已经固定了文档集合；不要每轮再次读取整张索引表。
        # 只有首次发现索引为空时，才走一次原有的构建路径。
        if get_snapshot_revision():
            results = await search_persistent_index(
                db, self.adapter.user_id, query,
                source_types={self.source_type}, scope=scope, limit=limit,
                diagnostics=diagnostics,
            )
            if int((diagnostics or {}).get("document_count", 0) or 0) > 0:
                return results
            documents = await self.adapter.build_documents(scope=scope)
            if documents:
                await replace_source_documents(db, self.adapter.user_id, self.source_type, documents)
                await db.commit()
                return await search_persistent_index(
                    db, self.adapter.user_id, query,
                    source_types={self.source_type}, scope=scope, limit=limit,
                    diagnostics=diagnostics,
                )
            return results

        documents = await load_index_documents(
            db, self.adapter.user_id, source_types={self.source_type},
        )
        if diagnostics is not None:
            diagnostics["document_count"] = len(documents)
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
        except TsSidecarUnavailable:
            if diagnostics is not None:
                diagnostics.update({"engine": "unavailable", "cache_hit": False,
                                    "fallback": "lexical_worker_unavailable"})
            return []


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
        from agent.rag.context import (
            get_snapshot_revision, reset_shared_index_key, set_shared_index_key,
        )
        snapshot_revision = get_snapshot_revision()
        shared_key = (
            f"snapshot:{snapshot_revision}"
            if snapshot_revision != "" else f"request:{uuid.uuid4().hex}"
        )
        shared_token = set_shared_index_key(shared_key)
        try:
            batches = await self.retriever.retrieve(
                query,
                source=source,
                scope=scope,
                strategy=strategy,
                candidate_limit=20,
            )
        finally:
            reset_shared_index_key(shared_token)
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
        if isinstance(scope, Scope) or isinstance(scope, (list, tuple)):
            query_scopes = list(scope) if isinstance(scope, (list, tuple)) else [scope]
            authorized: list[tuple[int, RecallCandidate]] = []
            for order, candidate in candidates:
                allowed = [candidate.document] if matches_any_scope(
                    candidate.document, query_scopes,
                ) else []
                rejected = 0 if allowed else 1
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
        candidate_values = [candidate for _, candidate in candidates]
        score_filter_started = time.monotonic()
        try:
            owner_id = candidate_values[0].scope.owner_user_id if candidate_values else ""
            scored_candidates, score_stats = await score_candidates_with_cache(
                owner_id, query, candidate_values, limit=requested_limit,
            )
        except TsSidecarUnavailable:
            # worker 故障不再回退到另一套 Python 评分算法，避免语义悄悄漂移。
            scored_candidates, score_stats = [], {
                "accepted_count": 0,
                "rejected_low_score": len(candidate_values),
                "rejected_not_preferred": 0,
                "top_confidence": 0.0,
                "threshold": 0.35,
                "preferred_threshold": 0.55,
                "scoring_version": "confidence-v1",
            }
        score_filter_ms = int((time.monotonic() - score_filter_started) * 1000)
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
        sidecar_values = [batch.metadata.get("sidecar_reused") == "True" for batch in batches
                          if "sidecar_reused" in batch.metadata]
        index_syncs = sorted({batch.metadata.get("index_sync") for batch in batches
                              if batch.metadata.get("index_sync")})
        upsert_count = sum(int(batch.metadata.get("upsert_count", "0") or 0) for batch in batches)
        delete_count = sum(int(batch.metadata.get("delete_count", "0") or 0) for batch in batches)
        stage_ms: dict[str, int] = {}
        for batch in batches:
            for key, value in batch.metadata.items():
                if key.endswith("_ms"):
                    try:
                        stage_ms[f"{batch.source_type}.{key}"] = int(float(value))
                    except (TypeError, ValueError):
                        continue
        stage_ms["score_filter_ms"] = score_filter_ms
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
            "cache_entries": (
                1
                if any(batch.metadata.get("shared_index") == "True" for batch in batches)
                else sum(int(batch.metadata.get("cache_entries", "0")) for batch in batches)
            ),
            "cache_miss_reasons": cache_miss_reasons,
            "sidecar_reused": bool(sidecar_values) and all(sidecar_values),
            "index_sync": index_syncs[-1] if index_syncs else None,
            "upsert_count": upsert_count,
            "delete_count": delete_count,
            "score_filter_ms": score_filter_ms,
            "stage_ms": stage_ms,
        }


async def search_memory(
    user_id, query: str, *, scope="auto", source: str = "all", strategy: str = "auto", limit: int = DEFAULT_RESULTS,
    mode: str = "tool", db=None, im_context: dict | None = None,
) -> dict:
    started = time.monotonic()
    query = (query or "").strip()
    if not query:
        return {"query": "", "results": [], "has_more": False, "message": "需要提供检索关键词"}
    query_scopes = await resolve_memory_query_scopes(
        user_id, scope, im_context=im_context, db=db,
    )
    retrievers = []
    if source in {"all", "profile", "pattern", "daily", "memory"}:
        retrievers.append(MemoryRetriever(user_id, source_filter=source if source != "knowledge" else "all"))
    if source in {"all", "knowledge"}:
        retrievers.append(KnowledgeAdapter(user_id))
    service = UnifiedRecallService(UnifiedRetriever(retrievers))
    result = await service.search(
        query, source="all" if source == "all" else source,
        scope=query_scopes,
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
        stages=result.get("stage_ms"),
        sidecar_reused=result.get("sidecar_reused"),
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
        # 让 Project 等数据库来源也能复用统一持久化 TypeScript lexical 索引。
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
        stages=result.get("stage_ms"),
        sidecar_reused=result.get("sidecar_reused"),
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


async def search_conversations(
    db, user_id, query: str, *, queries=None, limit: int = 6,
    mode: str = "tool", match_mode: str = "OR",
) -> dict:
    """历史会话的统一召回入口；不改变 conversations 工具的返回协议。"""
    started = time.monotonic()
    from agent.rag.scope import owner_scope
    from agent.rag.adapters.conversations import ConversationAdapter

    service = UnifiedRecallService(UnifiedRetriever([
        ConversationAdapter(user_id, db=db, queries=queries, mode=match_mode),
    ]))
    result = await service.search(
        query,
        source="conversation",
        scope=owner_scope(user_id),
        strategy="bm25",
        limit=max(1, min(int(limit or 6), 20)),
    )
    record_recall(
        namespace="conversation", source_type="conversation",
        candidate_count=result.get("candidate_count", 0),
        hit_count=len(result.get("results", [])),
        elapsed_ms=int((time.monotonic() - started) * 1000),
        fallback_reason=result.get("fallback_reason"),
        index_version="conversation-rag-v1", mode=mode,
        scope_type="owner", scope_key="", injected=False,
        engine=result.get("engine", "unknown"),
        stages=result.get("stage_ms"),
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
