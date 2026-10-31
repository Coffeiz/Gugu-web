"""保护 RAG rank facade 的分数分层、候选门控与输出预算行为。"""
from __future__ import annotations

import hashlib

from agent.rag.cython_rank import rank_candidates


def _candidate(candidate_id: str, source: str, raw_score: float, text: str, **fields):
    document = {
        "id": candidate_id, "text": text, "content": text, "source_type": source,
        "scope_type": "owner", "scope_id": "", "document_version": "v1",
        "parent_id": candidate_id, "title": candidate_id, "metadata": {},
    }
    document.update(fields.pop("document", {}))
    return {"id": candidate_id, "source_type": source, "raw_score": raw_score, "document": document, **fields}


def test_v4_prefers_preferred_band_and_excludes_unrelated_content() -> None:
    ranked, stats = rank_candidates("缓存", [
        _candidate("file:1", "file", 10, "缓存索引说明"),
        _candidate("file:2", "file", 5, "完全不同的内容"),
        _candidate("memory:1", "memory", 1, "缓存使用规则"),
    ], max_chars=1000)

    assert [item["id"] for item in ranked] == ["file:1"]
    assert ranked[0]["fused_score"] == ranked[0]["normalized_score"]
    assert stats["rejected_low_score"] == 1
    assert stats["rejected_not_preferred"] == 1
    assert stats["scoring_version"] == "confidence-v4"
    assert stats["output_chars"] == len("缓存索引说明")
    # 这些数值和选择统计取自同输入调用 TS rankCandidates 的 golden。
    assert ranked[0]["confidence"] == 0.8
    assert ranked[0]["source_quality"] == 0.8
    assert ranked[0]["normalized_score"] == 1.0
    assert stats["candidate_count"] == 1
    assert stats["rejected_not_preferred"] == 1


def test_top_k_bypasses_confidence_and_diversity_gates() -> None:
    candidates = [
        _candidate(f"memory:{index}", "memory", 5 - index, f"缓存相关记录 {index} 的具体内容",
                   document={"parent_id": "shared"})
        for index in range(5)
    ]
    ranked, stats = rank_candidates("毫不相干", candidates, selection_mode="top_k", max_chars=1000)

    assert len(ranked) == 5
    assert stats["rejected_low_score"] == 0
    assert stats["rejected_parent"] == 0
    assert stats["rejected_source"] == 0
    assert stats["rejected_similarity"] == 0


def test_history_hash_exclusion_uses_canonical_content_and_whitespace_variant() -> None:
    old_text = "壮志凌云独行侠的正文内容"
    old = _candidate("old", "file", 10, f"片名\n摘要\n{old_text}",
                     document={"content": old_text, "title": "片名", "summary": "摘要"})
    fresh = _candidate("fresh", "file", 5, "另一部电影正文")
    excluded = hashlib.sha256(old_text.encode()).hexdigest()

    ranked, stats = rank_candidates("壮志凌云", [old, fresh], selection_mode="top_k",
                                    exclude_content_hashes=[excluded], max_chars=1000)

    assert [item["id"] for item in ranked] == ["fresh"]
    assert stats["source_diagnostics"]["file"] == {
        "candidate_count": 2, "eligible_count": 1, "accepted_count": 1,
    }


def test_duplicate_content_aggregates_citations_and_counts_rejection() -> None:
    first = _candidate("file:1", "file", 2, "共同内容", document={
        "title": "文件来源", "metadata": {"source_id": "file-1"},
    })
    second = _candidate("canvas:1", "canvas", 1, "共同内容", document={
        "title": "画布来源", "metadata": {"source_id": "canvas-1"},
    })

    ranked, stats = rank_candidates("共同", [first, second], selection_mode="top_k", max_chars=1000)

    assert len(ranked) == 1
    assert [item["source_id"] for item in ranked[0]["citations"]] == ["file-1", "canvas-1"]
    assert stats["rejected_duplicate"] == 1
    assert stats["source_diagnostics"]["canvas"]["accepted_count"] == 0


def test_max_chars_truncates_context_not_canonical_text() -> None:
    candidate = _candidate("note:1", "note", 1, "查询内容后续正文", document={
        "context_text": "注入上下文需要截断",
    })

    ranked, stats = rank_candidates("查询", [candidate], selection_mode="top_k", max_chars=6)

    assert ranked[0]["text"] == "注入上下文需"
    assert stats["output_chars"] == 6
    assert ranked[0]["citation"]["chunk_id"] == "note:1:v1:0"


def test_rank_preserves_context_whitespace_when_budget_does_not_truncate() -> None:
    candidate = _candidate("note:space", "note", 1, "缓存正文", document={
        "context_text": "  缓存上下文  ",
    })

    ranked, stats = rank_candidates("缓存", [candidate], selection_mode="top_k", max_chars=100)

    assert ranked[0]["text"] == "  缓存上下文  "
    assert stats["output_chars"] == len("  缓存上下文  ")


def test_confidence_v4_includes_exact_preferred_threshold_boundary() -> None:
    # 同源归一分为 1.0、0.4、0；第二项置信度正好是
    # (0.75 * 0.4 + 0.25 * 1.0) * 1.0 = 0.55。
    candidates = [
        _candidate("knowledge:top", "knowledge", 1, "缓存查询"),
        _candidate("knowledge:boundary", "knowledge", 0.4, "缓存查询次项"),
        _candidate("knowledge:floor", "knowledge", 0, "缓存查询底项"),
    ]

    ranked, stats = rank_candidates("缓存查询", candidates, max_chars=100)

    boundary = next(item for item in ranked if item["id"] == "knowledge:boundary")
    assert boundary["confidence"] == 0.55
    assert stats["rejected_not_preferred"] == 0


def test_rank_falls_back_to_low_confidence_band_only_when_preferred_is_empty() -> None:
    # 同源常量分时 normalize 使用 score/(1+score)，确保单候选数值稳定。
    candidate = _candidate("canvas:1", "canvas", 1, "缓存相关知识", fused_score=0.8)
    lexical_max = _candidate("canvas:2", "canvas", 2, "无关内容", fused_score=1.0)
    ranked, stats = rank_candidates("缓存", [candidate, lexical_max], max_chars=1000)

    assert ranked
    assert 0.35 <= ranked[0]["confidence"] < 0.55
    assert stats["rejected_low_score"] == 1


def test_v1_score_matches_ts_golden_and_keeps_knowledge_quality_weight() -> None:
    candidate = _candidate("knowledge:1", "knowledge", 2, "缓存相关知识", document={
        "metadata": {"confidence": "confirmed"},
    })

    ranked, stats = rank_candidates("缓存", [candidate], scoring_version="confidence-v1", max_chars=1000)

    assert len(ranked) == 1
    assert ranked[0]["normalized_score"] == 2 / 3
    assert ranked[0]["source_quality"] == 0.8
    assert ranked[0]["confidence"] == 0.7766666666666667
    assert stats["scoring_version"] == "confidence-v1"


def test_confidence_selection_enforces_parent_then_source_caps() -> None:
    rows = []
    for index, parent in enumerate(("shared", "shared", "shared", "other-a", "other-b"), start=1):
        rows.append(_candidate(
            f"file:{index}", "file", 1, f"缓存规则第{index}组独立内容",
            fused_score=1.0, document={"parent_id": parent},
        ))

    ranked, stats = rank_candidates(
        "缓存", rows, max_per_parent=1, max_per_source=2, max_chars=1000,
    )

    assert [item["id"] for item in ranked] == ["file:1", "file:4"]
    assert stats["rejected_parent"] == 2
    assert stats["rejected_source"] == 1


def test_confidence_selection_rejects_near_duplicate_token_sets() -> None:
    shared = "缓存 alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"
    candidates = [
        _candidate("file:1", "file", 1, shared, fused_score=1.0),
        _candidate("file:2", "file", 1, shared + " mu", fused_score=1.0),
    ]

    ranked, stats = rank_candidates("缓存", candidates, max_chars=1000)

    assert [item["id"] for item in ranked] == ["file:1"]
    assert stats["rejected_similarity"] == 1
