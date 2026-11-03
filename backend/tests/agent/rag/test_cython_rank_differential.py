"""通过同一输入实时对照 TS rankCandidates，保护完整结果契约。"""
from __future__ import annotations

import json
import hashlib
import math
import random
import subprocess
import tempfile
from pathlib import Path

import pytest

from agent.rag.cython_rank import rank_candidates


_TS_RUNNER = r"""
import { readFileSync } from 'node:fs';
import { rankCandidates } from './backend/ts/workers/rag/src/ranking/rank-candidates.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.options?.corpusStatistics) {
  input.options.corpusStatistics.documentFrequency = new Map(
    Object.entries(input.options.corpusStatistics.documentFrequency),
  );
}
const result = rankCandidates(input.query, input.candidates, input.options);
process.stdout.write(JSON.stringify(result));
"""


def _candidate(identifier: str, source: str, text: str, score: float, **fields):
    document = {
        "id": identifier, "source_type": source, "text": text, "content": text,
        "title": f"标题 {identifier}", "summary": "", "parent_id": identifier,
        "document_version": "v1", "scope_type": "owner", "scope_id": "",
        "metadata": {},
    }
    document.update(fields.pop("document", {}))
    return {
        "id": identifier, "source_type": source, "raw_score": score,
        "document": document, **fields,
    }


def _assert_equal(actual, expected, path="result"):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), path
        for key in expected:
            _assert_equal(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index, (actual_item, expected_item) in enumerate(zip(actual, expected)):
            _assert_equal(actual_item, expected_item, f"{path}[{index}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12), path
    else:
        assert actual == expected, path


def test_python_rank_matches_ts_for_scores_ties_unicode_and_output_context() -> None:
    candidates = [
        _candidate(
            "memory:a", "memory", "缓存策略😀 Oct 2026 有效", 3.5,
            semantic_score=0.93,
            document={"context_text": "  上下文缓存策略😀 Oct 2026 有效  "},
        ),
        _candidate("knowledge:b", "knowledge", "缓存策略可用于十月", 2.5, semantic_score=0.81),
        _candidate("canvas:c", "canvas", "缓存策略图示", 2.5, semantic_score=0.4),
        _candidate("memory:d", "memory", "无关内容", 0.2, semantic_score=0.0),
        _candidate("project:e", "project", "缓存策略😀 Oct 2026 有效", 1.0),
        _candidate("canvas:f", "canvas", "\u0085缓存策略\u0085", 0.8,
                   document={"context_text": "\u0085上下文缓存策略\u0085"}),
        _candidate("tie-2", "file", "缓存策略 alpha 特殊文本", 4.0,
                   document={"updated_at": "2026-10-29T00:00:00Z", "document_version": "v2"}),
        _candidate("tie-10", "file", "缓存策略 beta 独立文本", 4.0,
                   document={"updated_at": "2026-10-30T00:00:00Z", "document_version": "v1"}),
    ]
    excluded_hash = hashlib.sha256("无关内容".encode()).hexdigest()
    cases = [
        ("confidence-v4", "confidence", 80, {}),
        ("confidence-v4", "top_k", 80, {}),
        # UTF-16 预算 8 正好把 emoji 的代理对切开，必须与 JS slice 一致。
        ("confidence-v4", "top_k", 8, {}),
        ("confidence-v1", "confidence", 80, {}),
        ("confidence-v1", "top_k", 80, {}),
        ("confidence-v4", "top_k", 120, {
            "excludeContentHashes": [excluded_hash],
            "corpusStatistics": {
                "documentCount": 120, "averageLength": 18.5,
                "documentFrequency": {"缓存": 8, "策略": 20, "Oct": 3, "2026": 2},
                "source": "differential-fixture",
            },
        }),
        # 对照 rank_score、fused、source priority 和更新时间相同/不同后的最终稳定顺序。
        ("confidence-v4", "top_k", 400, {"limit": 20}),
    ]

    for scoring_version, selection_mode, max_chars, extra_options in cases:
        options = {
            "limit": extra_options.get("limit", 4), "maxChars": max_chars, "maxPerSource": 3,
            "maxPerParent": 2, "selectionMode": selection_mode,
            "scoringVersion": scoring_version, **extra_options,
        }
        ts_input = {"query": "缓存策略 Oct 2026", "candidates": candidates, "options": options}
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", _TS_RUNNER],
            input=json.dumps(ts_input, ensure_ascii=False), text=True,
            capture_output=True, check=True, cwd=Path(__file__).parents[4],
        )
        ts_result = json.loads(completed.stdout)
        ts_result["diagnostics"].pop("elapsed_ms", None)

        python_results, python_diagnostics = rank_candidates(
            ts_input["query"], candidates,
            limit=options["limit"], max_chars=options["maxChars"],
            max_per_source=options["maxPerSource"], max_per_parent=options["maxPerParent"],
            selection_mode=selection_mode, scoring_version=scoring_version,
            exclude_content_hashes=options.get("excludeContentHashes", ()),
            corpus_statistics=(
                {
                    "document_count": options["corpusStatistics"]["documentCount"],
                    "average_length": options["corpusStatistics"]["averageLength"],
                    "document_frequency": options["corpusStatistics"]["documentFrequency"],
                    "source": options["corpusStatistics"]["source"],
                }
                if options.get("corpusStatistics") else None
            ),
        )
        python_diagnostics.pop("elapsed_ms", None)
        case = f"{scoring_version}.{selection_mode}.{max_chars}"
        _assert_equal(python_results, ts_result["results"], f"{case}.results")
        _assert_equal(python_diagnostics, ts_result["diagnostics"], f"{case}.diagnostics")


def test_python_rank_matches_ts_at_confidence_and_jaccard_boundaries() -> None:
    common_tokens = [f"word{index:02d}" for index in range(16)]
    first = "anchor " + " ".join(common_tokens)
    second = first + " unique-a unique-b unique-c"
    options = {
        "limit": 10, "maxChars": 2000, "maxPerSource": 10,
        "maxPerParent": 10, "selectionMode": "confidence",
        "scoringVersion": "confidence-v4",
    }
    scenarios = [
        ("缓存查询", [
            _candidate("knowledge:top", "knowledge", "缓存查询 top", 1.0),
            _candidate("knowledge:preferred", "knowledge", "缓存查询 preferred", 0.4),
            _candidate("knowledge:low", "knowledge", "缓存查询 low", 0.0),
        ]),
        ("alpha beta gamma delta epsilon", [
            _candidate("knowledge:low-boundary-top", "knowledge", "alpha beta gamma delta epsilon", 1.5),
            _candidate("knowledge:low-boundary", "knowledge", "alpha beta unrelated words", 0.5),
            _candidate("knowledge:low-boundary-floor", "knowledge", "unrelated content", 0.0),
        ]),
        # 两个 token set 的交集 17、并集 20，恰落在 Jaccard 0.85 拒绝边界。
        ("anchor", [
            _candidate("file:similar-a", "file", first, 2.0),
            _candidate("file:similar-b", "file", second, 2.0),
        ]),
    ]
    for query, candidates in scenarios:
        ts_input = {"query": query, "candidates": candidates, "options": options}
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", _TS_RUNNER],
            input=json.dumps(ts_input, ensure_ascii=False), text=True,
            capture_output=True, check=True, cwd=Path(__file__).parents[4],
        )
        ts_result = json.loads(completed.stdout)
        ts_result["diagnostics"].pop("elapsed_ms", None)
        python_results, python_diagnostics = rank_candidates(
            query, candidates, limit=options["limit"], max_chars=options["maxChars"],
            max_per_source=options["maxPerSource"], max_per_parent=options["maxPerParent"],
            selection_mode=options["selectionMode"], scoring_version=options["scoringVersion"],
        )
        python_diagnostics.pop("elapsed_ms", None)
        _assert_equal(python_results, ts_result["results"], f"{query}.results")
        _assert_equal(python_diagnostics, ts_result["diagnostics"], f"{query}.diagnostics")


def test_python_rank_matches_ts_for_deterministic_generated_candidate_sets() -> None:
    """固定种子的混合候选矩阵覆盖分数并列、Unicode、来源配额和空上下文组合。"""
    rng = random.Random(0xC17A)
    vocabulary = ["缓存", "索引", "alpha", "βeta", "😀", "十月", "上下文", "规则"]
    sources = [
        "memory", "knowledge", "project", "journal", "canvas", "conversation",
        "note", "calendar", "scheduled_task", "file",
    ]
    cases = []
    for case_index in range(96):
        candidates = []
        for candidate_index in range(rng.randint(1, 16)):
            identifier = f"case-{case_index:02d}-item-{candidate_index:02d}"
            source = rng.choice(sources)
            content = " ".join(rng.choices(vocabulary, k=rng.randint(1, 8)))
            parent = f"parent-{rng.randrange(max(1, candidate_index + 1))}"
            context = rng.choice((None, "", content, f"  {content}  ", "说明\n😀"))
            candidate = _candidate(
                identifier, source, content,
                rng.choice((-1.0, 0.0, 0.25, 0.55, 1.0, 1.0, 3.5)),
                semantic_score=rng.choice((None, 0.0, 0.35, 0.8, 1.0)),
                document={
                    "parent_id": parent,
                    "context_text": context,
                    "metadata": {"confidence": rng.choice(("confirmed", "probable", "unverified"))},
                },
            )
            if candidate.get("semantic_score") is None:
                candidate.pop("semantic_score")
            candidates.append(candidate)
        options = {
            "limit": rng.choice((0, 1, 2, 5, 8, 20, 51)),
            "maxChars": rng.choice((-1, 0, 1, 5, 32, 180, 1200)),
            "maxPerSource": rng.choice((-1, 0, 1, 2, 4)),
            "maxPerParent": rng.choice((-1, 0, 1, 3)),
            "selectionMode": rng.choice(("confidence", "top_k")),
            "scoringVersion": rng.choice(("confidence-v1", "confidence-v4")),
            "excludeContentHashes": [],
        }
        if case_index % 3 == 0:
            options["corpusStatistics"] = {
                "documentCount": 48,
                "averageLength": 11.25,
                "documentFrequency": {term: rng.randint(0, 20) for term in vocabulary},
                "source": "generated-fixture",
            }
        cases.append({"query": "缓存 alpha 十月", "candidates": candidates, "options": options})

    runner = _TS_RUNNER.replace(
        "if (input.options?.corpusStatistics) {\n  input.options.corpusStatistics.documentFrequency = new Map(\n    Object.entries(input.options.corpusStatistics.documentFrequency),\n  );\n}\n",
        "for (const item of input.cases) {\n  if (item.options?.corpusStatistics) {\n    item.options.corpusStatistics.documentFrequency = new Map(Object.entries(item.options.corpusStatistics.documentFrequency));\n  }\n}\n",
    ).replace(
        "const result = rankCandidates(input.query, input.candidates, input.options);\nprocess.stdout.write(JSON.stringify(result));",
        "const results = input.cases.map((item) => rankCandidates(item.query, item.candidates, item.options));\nprocess.stdout.write(JSON.stringify(results));",
    )
    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", runner],
        input=json.dumps({"cases": cases}, ensure_ascii=False), text=True,
        capture_output=True, check=True, cwd=Path(__file__).parents[4],
    )
    ts_results = json.loads(completed.stdout)
    assert len(ts_results) == len(cases)

    for case_index, (case, ts_result) in enumerate(zip(cases, ts_results)):
        ts_result["diagnostics"].pop("elapsed_ms", None)
        options = case["options"]
        python_results, python_diagnostics = rank_candidates(
            case["query"], case["candidates"],
            limit=options["limit"], max_chars=options["maxChars"],
            max_per_source=options["maxPerSource"], max_per_parent=options["maxPerParent"],
            selection_mode=options["selectionMode"], scoring_version=options["scoringVersion"],
            exclude_content_hashes=options["excludeContentHashes"],
            corpus_statistics=(
                {
                    "document_count": options["corpusStatistics"]["documentCount"],
                    "average_length": options["corpusStatistics"]["averageLength"],
                    "document_frequency": options["corpusStatistics"]["documentFrequency"],
                    "source": options["corpusStatistics"]["source"],
                }
                if "corpusStatistics" in options else None
            ),
        )
        python_diagnostics.pop("elapsed_ms", None)
        _assert_equal(python_results, ts_result["results"], f"generated[{case_index}].results")
        _assert_equal(python_diagnostics, ts_result["diagnostics"], f"generated[{case_index}].diagnostics")


def test_rank_rejects_malformed_wire_candidates_like_ts_worker() -> None:
    """候选 DTO 缺失/为空时两端都必须失败，避免 Python 静默把它当空正文排序。"""
    malformed = [
        None,
        {"id": "missing-document", "source_type": "memory", "raw_score": 1.0},
        {"id": "null-document", "source_type": "memory", "raw_score": 1.0, "document": None},
    ]
    requests = [
        {"op": "rank_candidates", "query": "缓存", "candidates": [candidate]}
        for candidate in malformed
    ]
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in requests),
            text=True, capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert len(responses) == len(malformed)
    assert all(item["status"] == "error" and item["code"] == "worker_failure" for item in responses)

    for candidate in malformed:
        with pytest.raises(TypeError, match="candidate 与 document"):
            rank_candidates("缓存", [candidate])


@pytest.mark.parametrize(
    ("query", "candidates"),
    [
        ("缓存", {"not": "an array"}),
    ],
)
def test_rank_rejects_invalid_top_level_wire_shapes_like_ts_worker(query, candidates) -> None:
    """协议顶层类型错误必须在两端失败，不能被 Cython facade 静默当空查询处理。"""
    request = {
        "op": "rank_candidates", "query": query, "candidates": candidates,
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input=json.dumps(request, ensure_ascii=False) + "\n", text=True,
            capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    response = json.loads(completed.stdout.splitlines()[-1])
    assert response["status"] == "error"
    assert response["code"] == "worker_failure"

    with pytest.raises((TypeError, AttributeError)):
        rank_candidates(query, candidates)


@pytest.mark.parametrize(
    ("wire_option", "value"),
    [
        ("limit", "不是数字"),
        ("limit", ""),
        ("limit", [2]),
        ("limit", {}),
        ("maxChars", "不是数字"),
        ("maxChars", ""),
        ("maxChars", [8]),
        ("maxChars", {}),
        ("limit", [[2]]),
        ("limit", "1_0"),
        ("maxChars", "\u0085 8 \u0085"),
        ("limit", 2.5),
        ("maxChars", 8.5),
    ],
)
def test_rank_numeric_option_coercion_matches_ts_number_semantics(wire_option, value) -> None:
    """预算字段按 TS Number()/NaN 比较语义处理，不能因 Python int() 偏离结果。"""
    candidates = [
        _candidate("memory-a", "memory", "缓存策略 alpha 第一份资料", 2.0),
        _candidate("project-b", "project", "缓存策略 beta 第二份资料", 1.0),
    ]
    options = {
        "limit": 2, "maxChars": 1000, "maxPerSource": 3,
        "maxPerParent": 3, "selectionMode": "top_k", "scoringVersion": "confidence-v1",
    }
    options[wire_option] = value
    request = {"query": "缓存策略", "candidates": candidates, "options": options}
    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", _TS_RUNNER],
        input=json.dumps(request, ensure_ascii=False), text=True,
        capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
    )
    expected = json.loads(completed.stdout)
    expected["diagnostics"].pop("elapsed_ms", None)

    actual, diagnostics = rank_candidates(
        request["query"], candidates, limit=options["limit"], max_chars=options["maxChars"],
        max_per_source=options["maxPerSource"], max_per_parent=options["maxPerParent"],
        selection_mode=options["selectionMode"], scoring_version=options["scoringVersion"],
    )
    diagnostics.pop("elapsed_ms", None)
    _assert_equal(actual, expected["results"])
    _assert_equal(diagnostics, expected["diagnostics"])


@pytest.mark.parametrize(
    ("wire_option", "value", "shared_field"),
    [
        ("maxPerSource", "不是数字", None),
        ("maxPerSource", "", None),
        ("maxPerSource", [2], None),
        ("maxPerSource", {}, None),
        ("maxPerSource", 2.5, None),
        ("maxPerParent", "不是数字", "parent_id"),
        ("maxPerParent", "", "parent_id"),
        ("maxPerParent", [2], "parent_id"),
        ("maxPerParent", {}, "parent_id"),
        ("maxPerParent", 2.5, "parent_id"),
    ],
)
def test_rank_diversity_numeric_options_match_ts_number_semantics(wire_option, value, shared_field) -> None:
    """来源/父文档配额使用 TS Number coercion，NaN 不应被 Python 转换异常替代。"""
    candidates = []
    for index, suffix in enumerate(("alpha sqlite", "bravo redis", "charlie vector", "delta cache", "echo graph", "foxtrot queue")):
        document = {shared_field: "shared-parent"} if shared_field else {}
        candidates.append(_candidate(
            f"memory-{index}", "memory", f"缓存策略 {suffix} {index}", 6 - index,
            document=document,
        ))
    options = {
        "limit": 6, "maxChars": 5000, "maxPerSource": 3,
        "maxPerParent": 3, "selectionMode": "confidence", "scoringVersion": "confidence-v1",
    }
    options[wire_option] = value
    request = {"query": "缓存策略", "candidates": candidates, "options": options}
    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", _TS_RUNNER],
        input=json.dumps(request, ensure_ascii=False), text=True,
        capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
    )
    expected = json.loads(completed.stdout)
    expected["diagnostics"].pop("elapsed_ms", None)

    actual, diagnostics = rank_candidates(
        request["query"], candidates, limit=options["limit"], max_chars=options["maxChars"],
        max_per_source=options["maxPerSource"], max_per_parent=options["maxPerParent"],
        selection_mode=options["selectionMode"], scoring_version=options["scoringVersion"],
    )
    diagnostics.pop("elapsed_ms", None)
    _assert_equal(actual, expected["results"])
    _assert_equal(diagnostics, expected["diagnostics"])


def test_rank_nullish_options_match_ts_worker_defaults() -> None:
    """TS JSONL 操作的 null query/candidates/options 采用的默认值一致。"""
    request = {
        "op": "rank_candidates", "query": None, "candidates": None,
        "limit": None, "max_chars": None, "max_per_source": None,
        "max_per_parent": None, "exclude_content_hashes": None,
        "selection_mode": None, "scoring_version": None,
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input=json.dumps(request, ensure_ascii=False) + "\n", text=True,
            capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    expected_response = json.loads(completed.stdout.strip().splitlines()[-1])
    assert expected_response["status"] == "ok"
    expected = expected_response["selected"]
    expected_diagnostics = expected_response["stats"]
    expected_diagnostics.pop("elapsed_ms", None)
    actual, diagnostics = rank_candidates(
        None, None, limit=None, max_chars=None, max_per_source=None,
        max_per_parent=None, selection_mode=None, scoring_version=None,
        exclude_content_hashes=None,
        corpus_statistics={
            "document_count": 0, "average_length": 0,
            "document_frequency": {}, "source": "full_ts_index",
        },
    )
    diagnostics.pop("elapsed_ms", None)
    _assert_equal(actual, expected)
    _assert_equal(diagnostics, expected_diagnostics)


def test_rank_rejects_unknown_scoring_version_instead_of_changing_algorithm() -> None:
    """非法评分版本两端都必须失败，不能静默降级到另一个 confidence 算法。"""
    request = {
        "op": "rank_candidates", "query": "", "candidates": [],
        "scoring_version": "confidence-v99",
    }
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input=json.dumps(request, ensure_ascii=False) + "\n", text=True,
            capture_output=True, check=True, cwd=Path(__file__).parents[4], timeout=30,
        )
    response = json.loads(completed.stdout.strip().splitlines()[-1])
    assert response["status"] == "error"
    assert response["code"] == "worker_failure"
    with pytest.raises(ValueError, match="scoring_version"):
        rank_candidates("", [], scoring_version="confidence-v99")
