from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope
from agent.rag.scoring import (
    HARD_CONFIDENCE_FLOOR,
    filter_confidence,
    normalize_scores,
    normalized_rrf,
)


def _candidate(source_id: str, score: float, content: str, rank: int) -> RecallCandidate:
    document = IndexDocument(
        f"memory:{source_id}", "memory", source_id, Scope("user-a"),
        "标题", "", content, "v1",
    )
    candidate = RecallCandidate.from_result(RecallResult(document, score), rank=rank)
    return candidate.__class__(
        **{**candidate.__dict__, "fused_score": normalized_rrf(rank) if score else 0.0},
    )


def test_normalize_scores_is_local_to_one_batch():
    values = normalize_scores([
        _candidate("a", 10, "缓存", 1),
        _candidate("b", 5, "其他", 2),
    ])

    assert values[0].normalized_score == 1
    assert values[1].normalized_score == 0


def test_low_confidence_candidates_are_rejected():
    selected, stats = filter_confidence(
        "完全不相关",
        [_candidate("a", 0, "无关内容", 1)],
        limit=5,
    )

    assert selected == []
    assert stats["rejected_low_score"] == 1
    assert stats["accepted_count"] == 0
    assert stats["scoring_version"] == "confidence-v1"
    assert HARD_CONFIDENCE_FLOOR == 0.35


def test_numeric_only_hit_does_not_make_unrelated_candidate_confident():
    candidate = _candidate("project", 2.3, "项目与工作：有 6 个进行中的项目", 1)
    selected, _ = filter_confidence("GTA 6", [candidate], limit=5)

    assert selected == []


def test_compact_entity_phrase_is_a_valid_match():
    candidate = _candidate("gta", 1.0, "GTA6 发售时间和新闻", 1)
    selected, _ = filter_confidence("GTA 6", [candidate], limit=5)

    assert len(selected) == 1
    assert selected[0].confidence >= 0.55
