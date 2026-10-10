import json
from types import SimpleNamespace

from scripts.diagnostics.rag_confidence_probe import (
    confidence_band,
    confidence_band_v4,
    confidence_distribution,
    confidence_v4,
    confidence_v2,
    document_length_ratio,
    idf_coverage,
    fp,
    load_run_cases,
    ranker_observation_limit,
    rescore_rank_score,
    sort_by_confidence_v4,
    source_quality_v4,
    query_match_length_penalty,
    _is_excluded_conversation_session,
    apply_confidence_v4,
)


def test_confidence_band_matches_production_thresholds():
    assert confidence_band(0.55) == "preferred"
    assert confidence_band(0.35) == "fallback"
    assert confidence_band(0.349999) == "rejected_low_score"


def test_confidence_band_v4_uses_new_preferred_threshold():
    assert confidence_band_v4(0.55) == "preferred"
    assert confidence_band_v4(0.549999) == "fallback"
    assert confidence_band_v4(0.35) == "fallback"
    assert confidence_band_v4(0.349999) == "rejected_low_score"


def test_confidence_distribution_keeps_boundary_counts():
    assert confidence_distribution([0.2, 0.35, 0.54, 0.55, 0.9]) == {
        "count": 5,
        "min": 0.2,
        "max": 0.9,
        "mean": 0.508,
        "preferred_ge_055": 2,
        "fallback_035_to_055": 2,
        "low_lt_035": 1,
    }


def test_confidence_distribution_empty_is_stable():
    assert confidence_distribution([]) == {
        "count": 0,
        "min": 0.0,
        "max": 0.0,
        "mean": 0.0,
        "preferred_ge_055": 0,
        "fallback_035_to_055": 0,
        "low_lt_035": 0,
    }


def test_ranker_observation_limit_is_independent_from_production_candidate_limit():
    """观察模式必须能看到旧 rank_score 前 20 之外的候选。"""
    assert ranker_observation_limit(20, 10) == 20
    assert ranker_observation_limit(50, 10) == 50
    assert ranker_observation_limit(5, 10) == 10
    assert ranker_observation_limit(100, 10) == 50


def test_confidence_v2_weights_high_idf_hit_more_than_low_idf_hit():
    item = {
        "fused_score": 0.5,
        "query_match": 0.5,
        "source_quality": 0.8,
        "query_idf_terms": [
            {"term": "普通词", "idf": 2.0},
            {"term": "t6", "idf": 8.0},
        ],
        "rank_contributions": [{"term": "t6"}],
    }
    value, coverage = confidence_v2(item)
    assert coverage == 0.941176
    assert value == 0.633235
    assert idf_coverage({**item, "rank_contributions": [{"term": "普通词"}]}) == 0.058824


def test_confidence_v4_uses_lexical_and_query_match_weights():
    """定稿乘法公式：(0.75*lex + 0.25*match) * quality。"""
    value, fused = confidence_v4(
        {"query_match": 0.5, "source_quality_v4": 0.8},
        lexical_norm=0.8,
    )
    assert fused == 0.8
    assert value == 0.58


def test_confidence_v4_does_not_apply_length_penalty():
    value, _ = confidence_v4(
        {"source_quality_v4": 1.0},
        lexical_norm=0.8,
    )
    assert value == 0.6


def test_confidence_v4_multiplies_source_quality_as_upper_bound():
    value, _ = confidence_v4(
        {"source_type": "conversation", "query_match": 0.5, "source_quality_v4": 0.5},
        lexical_norm=0.8,
    )
    assert value == 0.3625


def test_confidence_v4_blends_semantic_norm_when_available():
    # fused = 0.45*0.8 + 0.55*0.5 = 0.635；value = (0.75*0.635 + 0.25*0.5) * 1.0。
    value, fused = confidence_v4(
        {"source_quality_v4": 1.0, "query_match": 0.5},
        lexical_norm=0.8,
        semantic_norm=0.5,
    )
    assert fused == 0.635
    assert value == 0.60125


def test_apply_confidence_v4_injects_semantic_scores_by_candidate_key():
    rows = [
        {"source_type": "memory", "chunk_fp": fp("chunk-1"), "query_match": 1.0},
        {"source_type": "note", "chunk_fp": fp("chunk-2"), "query_match": 1.0},
    ]
    apply_confidence_v4(rows, semantic_scores={f"memory:{fp('chunk-1')}": 0.5})
    # memory 命中语义分：fused = 0.45*0 + 0.55*0.5（词法归一化为 0 的空贡献池）。
    assert rows[0]["semantic_norm_v4"] == 0.5
    assert rows[0]["fused_v4"] == 0.275
    # note 没有缓存向量：semantic 保持 0，fused 回落纯词法。
    assert rows[1]["semantic_norm_v4"] == 0.0
    assert rows[1]["fused_v4"] == 0.0


def test_query_match_length_penalty_only_reduces_long_documents():
    assert query_match_length_penalty(0.5) == 1.0
    assert query_match_length_penalty(1.0) == 1.0
    assert query_match_length_penalty(2.0) == 0.840896
    assert query_match_length_penalty(100.0) == 0.65


def test_document_length_ratio_is_recovered_from_ts_contribution():
    item = {
        "rank_contributions": [{
            "idf": 4.0,
            "queryWeight": 1.0,
            "termFrequency": 1,
            "weighted": 4.0 * 2.2 / 3.1,
        }],
    }
    assert document_length_ratio(item) == 2.0


def test_source_quality_v4_uses_requested_source_weights_and_unknown_fallback():
    assert source_quality_v4({"source_type": "calendar"}) == 0.8
    assert source_quality_v4({"source_type": "note"}) == 0.8
    assert source_quality_v4({"source_type": "project"}) == 0.8
    assert source_quality_v4({"source_type": "memory"}) == 0.8
    assert source_quality_v4({"source_type": "knowledge"}) == 1.0
    assert source_quality_v4({"source_type": "file"}) == 0.8
    assert source_quality_v4({"source_type": "canvas"}) == 0.6
    assert source_quality_v4({"source_type": "journal"}) == 0.8
    assert source_quality_v4({"source_type": "conversation"}) == 0.6
    assert source_quality_v4({"source_type": "unknown"}) == 0.6


def test_sort_by_confidence_v4_orders_observation_rows_by_confidence():
    rows = [
        {"original_rank": 1, "confidence_v4": 0.6, "rank_score_probe": 20},
        {"original_rank": 2, "confidence_v4": 0.8, "rank_score_probe": 10},
        {"original_rank": 3, "confidence_v4": 0.8, "rank_score_probe": 30},
    ]
    sort_by_confidence_v4(rows)
    assert [row["original_rank"] for row in rows] == [3, 2, 1]


def test_run_replay_filters_only_the_current_conversation_session():
    current = SimpleNamespace(
        document=SimpleNamespace(
            source_type="conversation", metadata={"session_id": "755"},
        ),
    )
    other = SimpleNamespace(
        document=SimpleNamespace(
            source_type="conversation", metadata={"session_id": "756"},
        ),
    )
    non_conversation = SimpleNamespace(
        document=SimpleNamespace(source_type="memory", metadata={"session_id": "755"}),
    )
    assert _is_excluded_conversation_session(current, 755)
    assert not _is_excluded_conversation_session(other, 755)
    assert not _is_excluded_conversation_session(non_conversation, 755)


def test_rescore_rank_score_reuses_contribution_for_probe_bm25_params():
    # 构造线上 length/average_length=2 的单词项：
    # online_norm=1+1.2*(0.25+0.75*2)=3.1，probe_norm=1+1*(0.5+0.5*2)=2.5。
    item = {
        "rank_contributions": [{
            "idf": 4.0,
            "queryWeight": 1.0,
            "termFrequency": 1,
            "weighted": 4.0 * 2.2 / 3.1,
        }],
    }
    # probe 侧 weighted=4*2*1/2.5=3.2，PROBE_RANK_P=1.5：3.2^1.5 ≈ 5.724334。
    assert rescore_rank_score(item) == 5.724334


def test_load_run_cases_keeps_dialogue_and_injected_recall(tmp_path):
    run_file = tmp_path / "runs.json"
    run_file.write_text(json.dumps({
        "runs": [{
            "id": "run-1",
            "trace_id": "trace-1",
            "input": {"user_id": "user-1"},
            "spans": [{
                "kind": "rag",
                "name": "Knowledge RAG recall",
                "status": "success",
                "output": {"candidate_count": 2, "hit_count": 1, "quality": {"top_confidence": 0.8}},
            }],
            "rounds": [{
                "attributes": {"round": 1},
                "input": {"messages": [
                    {"role": "user", "content": [{"type": "text", "text": "之前那个项目呢"}]},
                    {"role": "user", "content": [{"type": "knowledge-context", "text": "[owner-rag]\n检索问题：之前那个项目呢\n[1] project / Speedream\n项目正文\n[/owner-rag]"}]},
                ]},
            }],
        }],
    }, ensure_ascii=False), encoding="utf-8")

    cases = load_run_cases(str(run_file), full=True)
    assert len(cases) == 1
    assert cases[0]["query"] == "之前那个项目呢"
    assert cases[0]["original_recall"] == [{
        "original_rank": 1,
        "source_type": "project",
        "title": "Speedream",
        "content_fp": fp("项目正文"),
        "content": "项目正文",
    }]
    assert cases[0]["transcript"][0]["text"] == "之前那个项目呢"
    assert cases[0]["replay_exclude_content_hashes"]
    assert cases[0]["run_rag_diagnostics"][0]["quality"]["top_confidence"] == 0.8
