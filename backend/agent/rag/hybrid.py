"""BM25 与已有 embedding 缓存的确定性混合排序。"""
from __future__ import annotations

from agent.rag.models import IndexDocument, RecallResult


def _normalize(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    peak = max(scores.values())
    return {key: value / peak if peak > 0 else 0.0 for key, value in scores.items()}


def hybrid_results(
    lexical: list[RecallResult],
    documents: list[IndexDocument],
    query_vector: list[float] | None,
    vector_map: dict[str, list[float]] | None,
    *,
    lexical_weight: float = 0.6,
    vector_weight: float = 0.4,
    limit: int = 20,
) -> tuple[list[RecallResult], str | None]:
    """只对已有缓存向量的文档混合；没有缓存的候选保留 BM25 分数。"""
    if not query_vector or not vector_map:
        return lexical[:limit], "embedding_cache_unavailable"
    from agent.memory.embedding import cosine

    lexical_scores = _normalize({item.document.chunk_id: item.score for item in lexical})
    candidates = {item.document.chunk_id: item.document for item in lexical}
    vector_scores = {
        doc.chunk_id: cosine(query_vector, vector_map.get(doc.chunk_id) or [])
        for doc in documents if doc.chunk_id in candidates and vector_map.get(doc.chunk_id)
    }
    vector_scores = _normalize(vector_scores)
    scored = []
    for item in lexical:
        key = item.document.chunk_id
        score = lexical_weight * lexical_scores.get(key, 0.0) + vector_weight * vector_scores.get(key, 0.0)
        scored.append(RecallResult(item.document, score))
    scored.sort(key=lambda item: (-item.score, item.document.chunk_id))
    return scored[:limit], None if vector_scores else "embedding_cache_unavailable"
