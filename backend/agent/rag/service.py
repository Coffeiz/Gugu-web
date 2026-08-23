"""Knowledge RAG 统一召回服务与 Memory 首个来源实现。"""
from __future__ import annotations

import re
import time

from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.context import get_snapshot_context
from agent.rag.diagnostics import record_recall
from agent.rag.hybrid import hybrid_results
from agent.rag.lexical import BM25
from agent.rag.models import RecallResult
from agent.rag.retriever import RetrievalBatch, UnifiedRetriever
from agent.rag.scope import matches_scope, normalize_memory_scope
from agent.rag.storage import PersistentMemoryIndex


MAX_ACTIVE_RESULTS = 10
DEFAULT_RESULTS = 5
MAX_OUTPUT_CHARS = 3000
MAX_PER_SOURCE = 3


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
        return documents, "persistent"
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

        lexical = BM25(documents).search(query, limit=candidate_limit)
        final: list[RecallResult] = lexical
        fallback_reason = "embedding_disabled"
        if strategy in {"auto", "embedding"}:
            from agent.memory import embedding

            if embedding.is_enabled():
                query_vector = await embedding.embed(query)
                vector_map = await _load_cached_vectors(self.user_id, documents)
                final, fallback_reason = hybrid_results(
                    lexical, documents, query_vector, vector_map, limit=candidate_limit
                )
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
        )


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
        candidates = [result for batch in batches for result in batch.results]
        # 同一正文从多个来源返回时只占一份预算；引用合并由下面保留的 public item 表达。
        selected: list[dict] = []
        by_hash: dict[str, dict] = {}
        used_sources: dict[str, int] = {}
        used_parents: dict[str, int] = {}
        output_chars = 0
        for result in candidates:
            document = result.document
            public_item = result.as_public()
            content_key = document.content_hash
            existing = by_hash.get(content_key)
            if existing is not None:
                citation = public_item.get("citation")
                if citation and citation not in existing.setdefault("citations", []):
                    existing["citations"].append(citation)
                continue
            parent = document.parent_document_id or document.document_id
            if used_parents.get(parent, 0) >= 3:
                continue
            if used_sources.get(document.source_id, 0) >= MAX_PER_SOURCE:
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
            by_hash[content_key] = public_item
            used_sources[document.source_id] = used_sources.get(document.source_id, 0) + 1
            used_parents[parent] = used_parents.get(parent, 0) + 1
            output_chars += len(public_item["text"])
            if len(selected) >= requested_limit:
                break

        fallback_reasons = [batch.fallback_reason for batch in batches if batch.fallback_reason]
        return {
            "query": query,
            "results": selected,
            "has_more": len(candidates) > len(selected),
            "strategy": "hybrid" if batches and not all(fallback_reasons) else "bm25",
            "fallback_reason": fallback_reasons[0] if fallback_reasons else None,
            "index_source": ",".join(sorted({batch.index_source for batch in batches})),
            "sources": sorted({batch.source_type for batch in batches}),
            "candidate_count": sum(batch.candidate_count for batch in batches),
        }


async def search_memory(
    user_id, query: str, *, scope="auto", source: str = "all", strategy: str = "auto", limit: int = DEFAULT_RESULTS,
    mode: str = "tool",
) -> dict:
    started = time.monotonic()
    query = (query or "").strip()
    if not query:
        return {"query": "", "results": [], "has_more": False, "message": "需要提供检索关键词"}
    service = UnifiedRecallService(
        UnifiedRetriever([MemoryRetriever(user_id, source_filter=source)])
    )
    result = await service.search(
        query,
        source="memory",
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
        cached = (pattern if doc.source_id == "pattern" else memory).get(key or "")
        if cached and cached.get("t") == tag and isinstance(cached.get("v"), list):
            result[doc.chunk_id] = cached["v"]
    return result
