"""TypeScript lexical score 与已有 embedding 缓存的确定性混合排序。"""
from __future__ import annotations

from agent.rag.models import IndexDocument, RecallResult
from agent.rag.fusion import BM25_WEIGHT, VECTOR_WEIGHT, normalized_rrf


def hybrid_results(
    lexical: list[RecallResult],
    documents: list[IndexDocument],
    query_vector: list[float] | None,
    vector_map: dict[str, list[float]] | None,
    *,
    lexical_weight: float = BM25_WEIGHT,
    vector_weight: float = VECTOR_WEIGHT,
    limit: int = 20,
) -> tuple[list[RecallResult], str | None]:
    """只对已有缓存向量的文档混合；没有缓存的候选保留 lexical 分数。"""
    if not query_vector or not vector_map:
        return lexical[:limit], "embedding_cache_unavailable"
    from agent.memory.embedding import cosine

    candidates = {item.document.chunk_id: item.document for item in lexical}
    vector_scores = {
        doc.chunk_id: cosine(query_vector, vector_map.get(doc.chunk_id) or [])
        for doc in documents if doc.chunk_id in candidates and vector_map.get(doc.chunk_id)
    }
    vector_ranked = sorted(vector_scores, key=lambda key: (-vector_scores[key], key))
    vector_ranks = {key: index for index, key in enumerate(vector_ranked, start=1)}
    lexical_ranks = {
        item.document.chunk_id: index for index, item in enumerate(lexical, start=1)
    }
    scored = []
    for item in lexical:
        key = item.document.chunk_id
        score = lexical_weight * normalized_rrf(lexical_ranks[key])
        if key in vector_ranks:
            score += vector_weight * normalized_rrf(vector_ranks[key])
        scored.append(RecallResult(item.document, score))
    scored.sort(key=lambda item: (-item.score, item.document.chunk_id))
    return scored[:limit], None if vector_scores else "embedding_cache_unavailable"
