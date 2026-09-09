import json

from scripts.diagnostics.rag_confidence_probe import (
    confidence_band,
    confidence_distribution,
    confidence_v4,
    confidence_v2,
    idf_coverage,
    fp,
    load_run_cases,
    rescore_rank_score,
    sort_by_confidence_v4,
    source_quality_v4,
)


def test_confidence_band_matches_production_thresholds():
    assert confidence_band(0.55) == "preferred"
    assert confidence_band(0.35) == "fallback"
    assert confidence_band(0.349999) == "rejected_low_score"


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


def test_confidence_v4_uses_normalized_nonlinear_lexical_score_as_main_signal():
    value, fused = confidence_v4(
        {"query_match": 0.5, "source_quality": 0.8},
        lexical_norm=0.8,
    )
    assert fused == 0.8
    assert value == 0.74


def test_confidence_v4_downgrades_conversation_source_quality_to_half():
    value, _ = confidence_v4(
        {"source_type": "conversation", "query_match": 0.5, "source_quality_v4": 0.5},
        lexical_norm=0.8,
    )
    assert value == 0.62


def test_source_quality_v4_uses_requested_source_weights_and_unknown_fallback():
    assert source_quality_v4({"source_type": "calendar"}) == 0.5
    assert source_quality_v4({"source_type": "project"}) == 0.8
    assert source_quality_v4({"source_type": "memory"}) == 0.9
    assert source_quality_v4({"source_type": "knowledge"}) == 1.0
    assert source_quality_v4({"source_type": "file"}) == 0.8
    assert source_quality_v4({"source_type": "canvas"}) == 0.5
    assert source_quality_v4({"source_type": "journal"}) == 0.8
    assert source_quality_v4({"source_type": "unknown"}) == 0.5


def test_sort_by_confidence_v4_orders_observation_rows_by_confidence():
    rows = [
        {"original_rank": 1, "confidence_v4": 0.6, "rank_score_probe": 20},
        {"original_rank": 2, "confidence_v4": 0.8, "rank_score_probe": 10},
        {"original_rank": 3, "confidence_v4": 0.8, "rank_score_probe": 30},
    ]
    sort_by_confidence_v4(rows)
    assert [row["original_rank"] for row in rows] == [3, 2, 1]


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
    assert rescore_rank_score(item) == 10.24


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
