"""Knowledge RAG 统一召回服务与 Memory 首个来源实现。"""
from __future__ import annotations

import re
import time
import hashlib
from dataclasses import replace

from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.adapters.projects import ProjectAdapter
from agent.rag.adapters.indexed_sources import IndexedSourceRetriever
from agent.rag.context import get_snapshot_context
from agent.rag.diagnostics import record_recall
from agent.rag.hybrid import hybrid_results
from agent.rag.models import RecallCandidate, RecallResult, Scope
from agent.rag.persistent_store import search_persistent_index
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.ts_sidecar import (
    TsSidecarUnavailable,
    rank_candidates_with_cache,
)
from agent.rag.scope import (
    matches_any_scope,
    matches_scope,
    normalize_memory_scopes,
    resolve_memory_query_scopes,
)
from agent.rag.vector_cache import cache_key


MAX_ACTIVE_RESULTS = 25
DEFAULT_RESULTS = 5
MAX_OUTPUT_CHARS = 3000
MAX_PER_SOURCE = 3


def _scope_list(scope) -> list[Scope]:
    """把单 scope / 多 scope 统一成诊断用列表，不暴露 scope 原始标识。"""
    if isinstance(scope, Scope):
        return [scope]
    if isinstance(scope, (list, tuple)):
        return [item for item in scope if isinstance(item, Scope)]
    return []


def _scope_details(scope, candidates, ranked_candidates) -> list[dict[str, object]]:
    """返回逐 scope 的脱敏候选统计，避免多 scope 被误记为 owner。"""
    scopes = _scope_list(scope)
    selected = [item[0] for item in ranked_candidates]
    details = []
    for item in scopes:
        digest = hashlib.sha256(item.key().encode("utf-8")).hexdigest()[:12]
        details.append({
            "scope_type": item.scope_type,
            "scope_digest": digest,
            "candidate_count": sum(
                1 for candidate in candidates
                if matches_scope(candidate.document, item)
            ),
            "selected_count": sum(
                1 for candidate in selected
                if matches_scope(candidate.document, item)
            ),
        })
    return details


def _scope_record_fields(scope) -> tuple[str, str]:
    scopes = _scope_list(scope)
    if len(scopes) == 1:
        return scopes[0].scope_type, scopes[0].key()
    if len(scopes) > 1:
        return "multi", ""
    return "owner", ""


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


async def _memory_recall_documents(user_id, scope, source_filter) -> tuple[list, str, int]:
    """加载并过滤 Memory 候选文档；legacy 与 batch 共用同一语料口径。

    返回 (documents, index_source, document_load_ms)：已按来源过滤、scope 过滤
    和 snapshot 去重收口，直接可作为 worker 瞬态语料的输入。
    """
    import asyncio

    query_scopes = normalize_memory_scopes(user_id, scope)
    document_load_started = time.monotonic()
    loaded = await asyncio.gather(*[
        _load_memory_documents(user_id, query_scope)
        for query_scope in query_scopes
    ])
    document_load_ms = int((time.monotonic() - document_load_started) * 1000)
    documents = [document for docs, _ in loaded for document in docs]
    index_source = ",".join(sorted({source for _, source in loaded}))
    allowed_sources = {"profile", "pattern", "daily", "memory"}
    if source_filter != "all":
        allowed_sources &= {source_filter}
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
    return documents, index_source, document_load_ms


async def _memory_finalize(
    user_id, documents, lexical, query, *, strategy, candidate_limit, search_metadata,
    fuse=None,
):
    """Memory 词法命中之上的 embedding/hybrid 收尾；返回 (final, fusion, fallback_reason)。

    ``fuse(lexical, query_vector, vector_map) -> (final, fallback_reason)``：Phase 3 起
    batch 主链注入 TS hybrid_fuse；为 None 时走 Python ``hybrid_results``（回滚路径）。
    """
    if strategy not in {"auto", "bm25", "embedding"}:
        raise ValueError("strategy 只能是 auto、bm25 或 embedding")
    final: list = lexical
    fusion = "bm25"
    fallback_reason = "embedding_disabled"
    if not lexical:
        fallback_reason = "lexical_empty"
    if strategy in {"auto", "embedding"}:
        from agent.memory import embedding

        if embedding.is_enabled():
            query_vector = await embedding.embed(query)
            vector_map = await _load_cached_vectors(user_id, documents)
            if fuse is not None:
                final, fallback_reason = await fuse(lexical, query_vector, vector_map)
            else:
                final, fallback_reason = hybrid_results(
                    lexical, documents, query_vector, vector_map, limit=candidate_limit
                )
            if fallback_reason is None:
                fusion = "hybrid-rrf"
        elif strategy == "embedding":
            fallback_reason = "embedding_disabled"
    return final, fusion, fallback_reason


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
        documents, index_source, document_load_ms = await _memory_recall_documents(
            self.user_id, scope, self.source_filter,
        )
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
        final, fusion, fallback_reason = await _memory_finalize(
            self.user_id, documents, lexical, query,
            strategy=strategy, candidate_limit=candidate_limit,
            search_metadata=search_metadata,
        )
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

    def __init__(self, user_id, *, db=None, db_factory=None):
        self.adapter = ProjectAdapter(user_id, db=db, db_factory=db_factory)

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
        search_metadata: dict[str, object] = {}
        if self.adapter._db is not None:
            results = await self._search_db(
                self.adapter._db, query, query_scope, candidate_limit,
                diagnostics=search_metadata,
            )
        else:
            import app.db.session as db_session

            db_session.ensure_engine()
            factory = self.adapter._db_factory or db_session._SessionLocal
            async with factory() as db:
                results = await self._search_db(
                    db, query, query_scope, candidate_limit,
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

    async def _search_db(self, db, query: str, scope, limit: int,
                         diagnostics: dict[str, object] | None = None):
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
        exclude_content_hashes: set[str] | None = None,
        mode: str = "automatic",
    ) -> dict:
        requested_limit = max(1, min(int(limit or DEFAULT_RESULTS), MAX_ACTIVE_RESULTS))
        from agent.rag.context import (
            get_snapshot_revision, reset_shared_index_key, set_shared_index_key,
        )
        snapshot_revision = get_snapshot_revision()
        # 没有 snapshot 时保持普通 owner/revision 缓存路径。随机 request key 会让
        # 每次召回都绕过 revision cache，导致 persistent sidecar 也无法稳定复用。
        shared_key = f"snapshot:{snapshot_revision}" if snapshot_revision != "" else ""
        shared_token = set_shared_index_key(shared_key) if shared_key else None
        try:
            batches = await self.retriever.retrieve(
                query,
                source=source,
                scope=scope,
                strategy=strategy,
                candidate_limit=20,
            )
        finally:
            if shared_token is not None:
                reset_shared_index_key(shared_token)
        batch_order = {batch.source_type: index for index, batch in enumerate(batches)}
        candidates: list[tuple[int, RecallCandidate]] = []
        for batch in batches:
            # 来源内归一化、confidence 和最终预算统一交给 TS worker；Python
            # 只保留来源批次、权限边界和 canonical candidate 映射。
            batch_candidates = list(batch.candidates())
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
        candidate_values = [candidate for _, candidate in candidates]
        try:
            rank_kwargs = {
                "limit": requested_limit,
                "max_chars": MAX_OUTPUT_CHARS,
                "max_per_source": MAX_PER_SOURCE,
                "max_per_parent": 3,
            }
            if exclude_content_hashes is not None:
                rank_kwargs["exclude_content_hashes"] = exclude_content_hashes
            rank_kwargs["selection_mode"] = "top_k" if mode == "tool" else "confidence"
            ranked_candidates, rank_stats = await rank_candidates_with_cache(
                candidate_values[0].scope.owner_user_id if candidate_values else "",
                query, candidate_values, **rank_kwargs,
            )
        except TsSidecarUnavailable:
            ranked_candidates, rank_stats = [], {
                "candidate_count": len(candidate_values),
                "accepted_count": 0,
                "rejected_low_score": len(candidate_values),
                "rejected_not_preferred": 0,
                "top_confidence": 0.0,
                "threshold": 0.35,
                "preferred_threshold": 0.55,
                "selection_mode": "top_k" if mode == "tool" else "confidence",
                "scoring_version": "confidence-v1",
                "rejected_duplicate": 0,
                "rejected_parent": 0,
                "rejected_source": 0,
                "rejected_similarity": 0,
                "output_chars": 0,
            }

        selected: list[dict] = []
        for candidate, selected_text, rank_item in ranked_candidates:
            public_item = candidate.as_public()
            public_item.update({
                "text": selected_text,
                "confidence": round(float(rank_item.get("confidence") or 0), 6),
                "source_quality": round(float(rank_item.get("source_quality") or 0), 6),
                "normalized_score": round(float(rank_item.get("normalized_score") or 0), 6),
                "fused_score": round(float(rank_item.get("fused_score") or 0), 6),
            })
            public_item["citation"] = rank_item.get("citation") or public_item["citation"]
            public_item["citations"] = rank_item.get("citations") or [public_item["citation"]]
            selected.append(public_item)
        scope_details = _scope_details(scope, candidate_values, ranked_candidates)
        rejected_duplicate = int(rank_stats.get("rejected_duplicate", 0) or 0)
        rejected_parent = int(rank_stats.get("rejected_parent", 0) or 0)
        rejected_source = int(rank_stats.get("rejected_source", 0) or 0)
        rejected_diversity = int(rank_stats.get("rejected_similarity", 0) or 0)
        output_chars = int(rank_stats.get("output_chars", 0) or 0)

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
        stage_ms["rank_candidates_ms"] = int(rank_stats.get("elapsed_ms", 0) or 0)
        # TS ranker 的 source_diagnostics 只描述候选选择，不一定带来源索引的
        # cache/document 元数据。以来源批次为基准合并，避免诊断字段在有排序统计时
        # 被整块覆盖。
        ranked_source_diagnostics = rank_stats.get("source_diagnostics") or {}
        source_diagnostics = {}
        for batch in batches:
            source_diagnostics[batch.source_type] = {
                **(ranked_source_diagnostics.get(batch.source_type) or {}),
                "candidate_count": batch.candidate_count,
                "hit_count": len(batch.results),
                **batch.metadata,
            }
        return {
            "query": query,
            "results": selected,
            "has_more": int(rank_stats.get("candidate_count", len(candidate_values)) or 0) > len(selected),
            "strategy": "hybrid" if batches and not all(fallback_reasons) else "bm25",
            "fallback_reason": fallback_reasons[0] if fallback_reasons else None,
            "index_source": ",".join(sorted({batch.index_source for batch in batches})),
            "sources": sorted({batch.source_type for batch in batches}),
            "candidate_count": sum(batch.candidate_count for batch in batches),
            "permission_rejected": permission_rejected,
            "rejected_low_score": rank_stats.get("rejected_low_score", 0),
            "rejected_not_preferred": rank_stats.get("rejected_not_preferred", 0),
            "rejected_duplicate": rejected_duplicate,
            "rejected_parent": rejected_parent,
            "rejected_source": rejected_source,
            "rejected_diversity": rejected_diversity,
            "accepted_count": len(selected),
            "top_confidence": rank_stats.get("top_confidence", 0),
            "confidence_threshold": rank_stats.get("threshold", 0.35),
            "preferred_confidence_threshold": rank_stats.get("preferred_threshold", 0.55),
            "selection_mode": rank_stats.get("selection_mode", "confidence"),
            "scoring_version": rank_stats.get("scoring_version", "confidence-v1"),
            "engine": next(iter(engines)) if len(engines) == 1 else ("mixed" if engines else "unknown"),
            "cache_hit": bool(cache_values) and all(cache_values),
            "cache_entries": (
                1
                if any(batch.metadata.get("shared_index") == "True" for batch in batches)
                else sum(int(batch.metadata.get("cache_entries", "0")) for batch in batches)
            ),
            "cache_miss_reasons": cache_miss_reasons,
            # 没有执行 reuse_if_current 时不应伪造 false；false 只表示实际检查过
            # 且确认未复用，None 表示本轮没有发生 restore/reuse 判断。
            "sidecar_reused": None if not sidecar_values else all(sidecar_values),
            "index_sync": index_syncs[-1] if index_syncs else None,
            "upsert_count": upsert_count,
            "delete_count": delete_count,
            "rank_candidates_ms": int(rank_stats.get("elapsed_ms", 0) or 0),
            "stage_ms": stage_ms,
            "source_diagnostics": source_diagnostics,
            "scope_diagnostics": scope_details,
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
        if db is not None:
            retrievers.append(IndexedSourceRetriever(user_id, db=db, source_type="knowledge"))
    service = UnifiedRecallService(UnifiedRetriever(retrievers))
    result = await service.search(
        query, source="all" if source == "all" else source,
        scope=query_scopes,
        strategy=strategy,
        limit=limit,
        mode=mode,
    )
    scope_type, scope_key = _scope_record_fields(query_scopes)
    record_recall(
        namespace="knowledge",
        source_type="memory",
        candidate_count=result.get("candidate_count", 0),
        hit_count=len(result["results"]),
        elapsed_ms=int((time.monotonic() - started) * 1000),
        fallback_reason=result.get("fallback_reason"),
        index_version="memory-rag-v1",
        mode=mode,
        scope_type=scope_type,
        scope_key=scope_key,
        injected=bool(result.get("results")),
        engine=result.get("engine", "unknown"),
        cache_hit=result.get("cache_hit"),
        cache_entries=result.get("cache_entries"),
        cache_miss_reasons=result.get("cache_miss_reasons"),
        stages=result.get("stage_ms"),
        source_diagnostics=result.get("source_diagnostics"),
        scope_details=result.get("scope_diagnostics"),
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
    limit: int = DEFAULT_RESULTS, mode: str = "automatic", db=None, db_factory=None,
    exclude_content_hashes: set[str] | None = None,
) -> dict:
    """统一 Knowledge 入口：注册 memory、knowledge、project、file、canvas、note、conversation 来源。

    `search_memory` 保持记忆专用工具语义；自动召回和跨来源入口使用本函数。
    """
    started = time.monotonic()
    query = (query or "").strip()
    if not query:
        return {"query": "", "results": [], "has_more": False, "message": "需要提供检索关键词"}
    if scope == "auto":
        # 自动 Knowledge 召回没有直接的 IM scope 参数时只允许 owner 范围；
        # 群聊调用方必须先传入已完成 ACL 校验的 Scope，不能把字符串 auto
        # 传给来源适配器后静默跳过所有新增来源。
        from agent.rag.scope import owner_scope
        scope = owner_scope(user_id)
    if db is None and db_factory is None:
        # Web/IM 的自动召回通常没有沿调用链携带 DB session。把 sessionmaker
        # 传给各数据库来源，让并行 retriever 各自创建和释放独立会话。
        import app.db.session as db_session
        # 统一走 ensure_engine，处理跨事件循环和 reset_engine 的生命周期，
        # 不要直接读取 _engine 再调用私有构造函数。
        db_session.ensure_engine()
        session_factory = db_session._SessionLocal
        if session_factory is None:
            raise RuntimeError("RAG 数据库会话工厂未初始化")
        db_factory = session_factory
    retrievers = [
        MemoryRetriever(user_id),
        IndexedSourceRetriever(user_id, db=db, source_type="knowledge"),
        ProjectRetriever(user_id, db=db, db_factory=db_factory),
        IndexedSourceRetriever(user_id, db=db, db_factory=db_factory, source_type="file"),
        IndexedSourceRetriever(user_id, db=db, db_factory=db_factory, source_type="canvas"),
        IndexedSourceRetriever(user_id, db=db, db_factory=db_factory, source_type="note"),
        IndexedSourceRetriever(user_id, db=db, db_factory=db_factory, source_type="conversation"),
    ]
    if mode == "automatic" and source == "all":
        from app.core.config import get_settings
        enabled = set(get_settings().search.rag_auto_sources)
        retrievers = [item for item in retrievers if item.source_type in enabled]
    from app.core.config import get_settings
    from agent.rag.batch_retriever import BatchUnifiedRetriever, ShadowUnifiedRetriever
    retriever_class = {
        "batch": BatchUnifiedRetriever,
        "batch_shadow": ShadowUnifiedRetriever,
    }.get(get_settings().search.rag_query_mode, UnifiedRetriever)
    service = UnifiedRecallService(retriever_class(retrievers))
    result = await service.search(
        query, source=source, scope=scope, strategy=strategy, limit=limit,
        exclude_content_hashes=exclude_content_hashes,
        mode=mode,
    )
    scope_type, scope_key = _scope_record_fields(scope)
    record_recall(
        namespace="knowledge", source_type="all" if source == "all" else source,
        candidate_count=result.get("candidate_count", 0), hit_count=len(result["results"]),
        elapsed_ms=int((time.monotonic() - started) * 1000),
        fallback_reason=result.get("fallback_reason"),
        index_version="knowledge-rag-v1", mode=mode,
        scope_type=scope_type,
        scope_key=scope_key,
        injected=bool(result.get("results")),
        engine=result.get("engine", "unknown"),
        cache_hit=result.get("cache_hit"),
        cache_entries=result.get("cache_entries"),
        cache_miss_reasons=result.get("cache_miss_reasons"),
        stages=result.get("stage_ms"),
        sidecar_reused=result.get("sidecar_reused"),
        source_diagnostics=result.get("source_diagnostics"),
        scope_details=result.get("scope_diagnostics"),
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
        mode=mode,
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
    """读取 Memory、Knowledge 和 pattern 专属缓存，不在查询热路径生成向量。"""
    from agent.memory import embedding, store
    from agent.knowledge.vector_cache import read_vectors as read_knowledge_vectors

    tag = embedding.model_tag()
    pattern = await store.read_pattern_vecs(user_id)
    memory = await store.read_memory_vecs(user_id)
    knowledge = await read_knowledge_vectors(user_id)
    result: dict[str, list[float]] = {}
    for doc in documents:
        key = doc.metadata.get("vector_key")
        if doc.source_id == "pattern":
            cached = pattern.get(key or "")
        elif doc.source_type == "knowledge":
            cached = knowledge.get(cache_key(doc) or "")
        else:
            cached = memory.get(cache_key(doc) or "")
        if cached and cached.get("t") == tag and isinstance(cached.get("v"), list):
            result[doc.chunk_id] = cached["v"]
    return result
