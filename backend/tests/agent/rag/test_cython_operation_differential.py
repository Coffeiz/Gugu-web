"""对照 TS worker 的独立操作协议与 Cython facade 结果。"""
from __future__ import annotations

import json
import math
from pathlib import Path
import random
import subprocess
import tempfile
from types import SimpleNamespace

import pytest

from agent.rag.cython_backend import fuse_hybrid_candidates
from scripts.benchmarks.benchmark_rag_cython_real import _ranking_text


def test_real_rag_benchmark_uses_full_conversation_ranking_text() -> None:
    """真实 A/B 的 conversation 索引必须使用 TS 当前消息全文而非分块正文。"""
    document = SimpleNamespace(
        source_type="conversation",
        metadata={"context_current": "完整当前消息"},
        content="当前存储分块",
    )
    assert _ranking_text(document) == "完整当前消息"


def _assert_wire_equal(actual, expected, path="response"):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), path
        for key in expected:
            _assert_wire_equal(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index, (left, right) in enumerate(zip(actual, expected)):
            _assert_wire_equal(left, right, f"{path}[{index}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isclose(actual, expected, rel_tol=0, abs_tol=1e-12), path
    else:
        assert actual == expected, path


@pytest.mark.parametrize("payload", [
    {
        "op": "hybrid_fuse", "vector_version": "model:v2", "limit": 10,
        "hits": [
            {"chunk_id": "b", "score": 3.25},
            {"chunk_id": "a", "score": 2.0},
            {"chunk_id": "c", "score": 1.0},
        ],
        "query_vector": [1.0, 0.0],
        "vectors": {"a": [1.0, 0.0], "b": [0.0, 1.0, 0.0], "c": [0.0, 0.0]},
    },
    {
        # 等融合分数与等向量分数的 mixed-case id 暴露 comparator 差异。
        "op": "hybrid_fuse", "limit": 10,
        "hits": [{"chunk_id": "a", "score": 2.0}, {"chunk_id": "A", "score": 1.0}],
        "query_vector": [1.0, 0.0],
        "vectors": {"a": [1.0, 0.0], "A": [1.0, 0.0]},
    },
    {
        # JS 按 UTF-16 code unit 排序；补充面字符与 BMP 私用区字符顺序不同于 Python code point。
        "op": "hybrid_fuse", "limit": 10,
        "hits": [{"chunk_id": "\U0001f600", "score": 1.0}, {"chunk_id": "\ue000", "score": 1.0}],
        "query_vector": [1.0],
        "vectors": {"\U0001f600": [1.0], "\ue000": [1.0]},
    },
    {
        "op": "hybrid_fuse", "limit": 2,
        "hits": [{"chunk_id": "z", "score": 0.8}, {"chunk_id": "a", "score": 0.4}],
        "query_vector": [], "vectors": {"unrelated": [1.0, 0.0]},
    },
    {
        "op": "hybrid_fuse", "limit": 2,
        "hits": [{"chunk_id": "z", "score": 0.8}, {"chunk_id": "a", "score": 0.4}],
        "query_vector": [1.0, 0.0], "vectors": {"unrelated": [1.0, 0.0]},
    },
])
def test_cython_hybrid_fuse_matches_ts_operation(payload) -> None:
    """混合命中、零/错维向量、fallback 与并列顺序保持 TS 操作输出契约。"""
    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input=json.dumps(payload, ensure_ascii=False) + "\n",
            text=True, capture_output=True, check=True,
            cwd=Path(__file__).parents[4], timeout=30,
        )
    expected = json.loads(completed.stdout.strip().splitlines()[-1])
    expected.pop("version", None)

    results, diagnostics = fuse_hybrid_candidates(
        payload["hits"], payload["query_vector"], payload["vectors"],
        limit=payload["limit"],
        lexical_weight=payload.get("lexical_weight", 0.45),
        vector_weight=payload.get("vector_weight", 0.55),
        rrf_k=payload.get("rrf_k", 60),
        vector_version=payload.get("vector_version", ""),
    )
    actual = {"status": "ok", **diagnostics, "results": results}
    _assert_wire_equal(actual, expected)


def test_cython_hybrid_fuse_matches_ts_for_generated_vectors_and_fallbacks() -> None:
    """随机混合命中、缺失/错维/零向量与边界 limit 不得改变融合排序或 fallback。"""
    rng = random.Random(0xC1A0)
    requests = []
    for case_index in range(64):
        dimension = rng.randint(1, 5)
        hits = [
            {"chunk_id": f"候选-{case_index:02d}-{index:02d}", "score": rng.choice((0, 0.1, 0.5, 1, 3.25))}
            for index in range(rng.randint(0, 12))
        ]
        vectors = {}
        for hit in hits:
            if rng.random() < 0.68:
                vector_dimension = rng.choice((dimension, dimension, dimension + 1))
                vectors[hit["chunk_id"]] = (
                    [0.0] * vector_dimension if rng.random() < 0.15
                    else [rng.choice((-1.0, -0.25, 0.0, 0.5, 1.0)) for _ in range(vector_dimension)]
                )
        requests.append({
            "op": "hybrid_fuse",
            "hits": hits,
            "query_vector": (
                [] if case_index % 9 == 0
                else [rng.choice((-1.0, 0.0, 0.25, 1.0)) for _ in range(dimension)]
            ),
            "vectors": vectors,
            "limit": rng.choice((0, 1, 2, 10, 20, 200, 201)),
            "lexical_weight": rng.choice((0.0, 0.25, 0.45, 1.0)),
            "vector_weight": rng.choice((0.0, 0.3, 0.55, 1.0)),
            "rrf_k": rng.choice((0, 1, 10, 60, 120)),
            "vector_version": f"fixture:{case_index % 3}",
        })

    with tempfile.TemporaryDirectory() as index_dir:
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "backend/ts/workers/rag/src/index.ts", index_dir],
            input="".join(json.dumps(request, ensure_ascii=False) + "\n" for request in requests),
            text=True, capture_output=True, check=True,
            cwd=Path(__file__).parents[4], timeout=60,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert len(responses) == len(requests)

    for case_index, (request, expected) in enumerate(zip(requests, responses)):
        expected.pop("version", None)
        results, diagnostics = fuse_hybrid_candidates(
            request["hits"], request["query_vector"], request["vectors"],
            limit=request["limit"], lexical_weight=request["lexical_weight"],
            vector_weight=request["vector_weight"], rrf_k=request["rrf_k"],
            vector_version=request["vector_version"],
        )
        actual = {"status": "ok", **diagnostics, "results": results}
        _assert_wire_equal(actual, expected, f"hybrid_fuse.case[{case_index}]")
