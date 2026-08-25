"""RAG Phase 2–4 的统一评分、置信度和多样性原语。"""
from __future__ import annotations

import re
from dataclasses import replace

from agent.rag.models import RecallCandidate
from agent.rag.tokenizer import tokenize

RRF_K = 60
BM25_WEIGHT = 0.45
VECTOR_WEIGHT = 0.55
HARD_CONFIDENCE_FLOOR = 0.35
PREFERRED_CONFIDENCE = 0.55
SCORING_VERSION = "confidence-v1"
SOURCE_QUALITY = {
    "memory": 0.80, "project": 0.90, "file": 0.80,
    "canvas": 0.75, "conversation": 0.65, "journal": 0.70,
    "knowledge": 0.80,
}


def normalize_scores(candidates: list[RecallCandidate]) -> list[RecallCandidate]:
    """只在同一来源批次内归一化 raw score。"""
    if not candidates:
        return []
    scores = [candidate.raw_score for candidate in candidates]
    low, high = min(scores), max(scores)
    if high <= low:
        # 单候选不能因为“排名第一”自动获得满分；用有界 raw score
        # 保留绝对命中强度，避免弱数字命中被抬成高置信结果。
        values = [
            max(0.0, score) / (1.0 + max(0.0, score))
            for score in scores
        ]
    else:
        values = [(score - low) / (high - low) for score in scores]
    return [replace(candidate, normalized_score=value) for candidate, value in zip(candidates, values)]


def normalized_rrf(rank: int, *, weight: float = 1.0) -> float:
    """把单路 RRF 转成 0–1 范围，避免跨来源比较原始分。"""
    rank = max(1, int(rank))
    return weight * (RRF_K + 1) / (RRF_K + rank)


def query_match(query: str, candidate: RecallCandidate) -> float:
    query_text = (query or "").strip()
    query_tokens = set(tokenize(query_text))
    meaningful_tokens = {
        token for token in query_tokens
        if not re.fullmatch(r"[\d\W_]+", token, flags=re.UNICODE)
    }
    if not meaningful_tokens:
        return 0.0
    text = "\n".join((candidate.document.title, candidate.document.summary, candidate.document.content))
    document_tokens = set(tokenize(text))
    # 对中英文实体保留紧凑短语匹配：GTA 6、GTA6 视为同一实体。
    compact_query = re.sub(r"\s+", "", query_text).casefold()
    compact_document = re.sub(r"\s+", "", text).casefold()
    if compact_query and len(compact_query) >= 2 and compact_query in compact_document:
        return 1.0
    return len(meaningful_tokens & document_tokens) / len(meaningful_tokens)


def confidence_for(query: str, candidate: RecallCandidate) -> RecallCandidate:
    source_quality = SOURCE_QUALITY.get(candidate.source_type, 0.70)
    if candidate.source_type == "knowledge":
        confidence_weight = {
            "confirmed": 1.0,
            "probable": 0.85,
            "unverified": 0.65,
            "conflict": 0.35,
        }.get(str(candidate.document.metadata.get("confidence") or "confirmed"), 0.65)
        source_quality *= confidence_weight
    match = min(1.0, query_match(query, candidate))
    fused = candidate.fused_score or candidate.normalized_score
    confidence = 0.55 * fused + 0.25 * match + 0.20 * source_quality
    if match <= 0.0:
        # 没有任何有效语义词命中时，来源质量不能把候选抬过硬下限。
        confidence = min(confidence, HARD_CONFIDENCE_FLOOR - 0.01)
    return replace(candidate, confidence=min(1.0, max(0.0, confidence)), source_quality=source_quality)


def filter_confidence(query: str, candidates: list[RecallCandidate], *, limit: int):
    """优先保留高置信结果；没有高分结果时才允许低分补位。"""
    scored = [confidence_for(query, candidate) for candidate in candidates]
    preferred = [item for item in scored if item.confidence >= PREFERRED_CONFIDENCE]
    fallback = [item for item in scored if HARD_CONFIDENCE_FLOOR <= item.confidence < PREFERRED_CONFIDENCE]
    selected = (preferred if preferred else fallback)[:max(1, int(limit))]
    selected_ids = {id(item) for item in selected}
    rejected_low_score = sum(item.confidence < HARD_CONFIDENCE_FLOOR for item in scored)
    rejected_not_preferred = sum(
        bool(preferred) and id(item) not in selected_ids
        for item in scored
        if item.confidence >= HARD_CONFIDENCE_FLOOR
    )
    return selected, {
        "accepted_count": len(selected),
        "rejected_low_score": rejected_low_score,
        "rejected_not_preferred": rejected_not_preferred,
        "top_confidence": max((item.confidence for item in scored), default=0.0),
        "threshold": HARD_CONFIDENCE_FLOOR,
        "preferred_threshold": PREFERRED_CONFIDENCE,
        "scoring_version": SCORING_VERSION,
    }


def token_similarity(left: RecallCandidate, right: RecallCandidate) -> float:
    """轻量 Jaccard 多样性指标；不引入额外 embedding 请求。"""
    left_tokens = set(tokenize(left.document.content))
    right_tokens = set(tokenize(right.document.content))
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


__all__ = [
    "BM25_WEIGHT", "HARD_CONFIDENCE_FLOOR", "PREFERRED_CONFIDENCE",
    "RRF_K", "SCORING_VERSION", "SOURCE_QUALITY", "VECTOR_WEIGHT", "confidence_for",
    "filter_confidence", "normalize_scores", "normalized_rrf", "query_match",
    "token_similarity",
]
