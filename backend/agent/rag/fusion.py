"""RAG 向量融合所需的稳定评分原语。"""
from __future__ import annotations

RRF_K = 60
BM25_WEIGHT = 0.45
VECTOR_WEIGHT = 0.55


def normalized_rrf(rank: int, *, weight: float = 1.0) -> float:
    """把单路 RRF 转成 0-1 范围，避免跨来源比较原始分。"""
    rank = max(1, int(rank))
    return weight * (RRF_K + 1) / (RRF_K + rank)


__all__ = ["BM25_WEIGHT", "RRF_K", "VECTOR_WEIGHT", "normalized_rrf"]
