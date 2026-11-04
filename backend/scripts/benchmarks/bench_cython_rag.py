#!/usr/bin/env python3
"""合成语料下比较 Python、Cython BM25 内核与现有 TS BM25 基准。"""
from __future__ import annotations

import argparse
import math
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from array import array
from collections import defaultdict
from pathlib import Path
from typing import Callable


REPO_ROOT = Path(__file__).resolve().parents[3]
TS_BENCHMARK = REPO_ROOT / "backend/scripts/benchmarks/bench_rag_bm25.ts"


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[round((len(ordered) - 1) * fraction)]


def _build_corpus(document_count: int, vocabulary_size: int, terms_per_document: int) -> list[list[str]]:
    rng = random.Random(20261029)
    vocabulary = [f"词项{index:04d}" for index in range(vocabulary_size)]
    return [
        [rng.choice(vocabulary) for _ in range(terms_per_document)]
        for _ in range(document_count)
    ]


def _build_index(documents: list[list[str]]) -> tuple[list[int], dict[str, list[tuple[int, int]]], float]:
    lengths: list[int] = []
    postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for document_id, terms in enumerate(documents):
        frequencies: dict[str, int] = {}
        for term in terms:
            frequencies[term] = frequencies.get(term, 0) + 1
        length = sum(frequencies.values())
        lengths.append(length)
        for term, frequency in frequencies.items():
            postings[term].append((document_id, frequency))
    return lengths, dict(postings), (sum(lengths) / len(lengths) if lengths else 0.0)


def _python_search(
    lengths: list[int], postings: dict[str, list[tuple[int, int]]], average_length: float,
    query_terms: list[str], limit: int,
) -> list[tuple[int, float]]:
    scores: dict[int, float] = {}
    document_count = len(lengths)
    for term in query_terms:
        posting = postings.get(term)
        if not posting:
            continue
        document_frequency = len(posting)
        idf = math.log(1.0 + (document_count - document_frequency + 0.5) / (document_frequency + 0.5))
        for document_id, frequency in posting:
            length = max(1, lengths[document_id])
            norm = frequency + 1.2 * (1.0 - 0.75 + 0.75 * length / max(1.0, average_length))
            scores[document_id] = scores.get(document_id, 0.0) + idf * frequency * 2.2 / norm
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:limit]


def _python_csr_search(
    lengths: array, offsets: array, posting_ids: array, frequencies: array,
    document_frequencies: array, tie_ranks: array, query_ids: list[int], average_length: float, limit: int,
) -> list[tuple[int, float]]:
    """与 Cython 共用 CSR 数据和 Top-K 策略，隔离 Python 循环成本。"""
    scores = [0.0] * len(lengths)
    document_count = len(lengths)
    for term_id in query_ids:
        if term_id < 0:
            continue
        document_frequency = document_frequencies[term_id]
        if document_frequency <= 0:
            continue
        idf = math.log(1.0 + (document_count - document_frequency + 0.5) / (document_frequency + 0.5))
        for posting_index in range(offsets[term_id], offsets[term_id + 1]):
            document_id = posting_ids[posting_index]
            frequency = frequencies[posting_index]
            length = max(1, lengths[document_id])
            norm = frequency + 1.2 * (1.0 - 0.75 + 0.75 * length / max(1.0, average_length))
            scores[document_id] += idf * frequency * 2.2 / norm

    result: list[tuple[int, float]] = []
    result_limit = max(1, min(limit, document_count))
    for document_id, score in enumerate(scores):
        if score <= 0.0:
            continue
        position = 0
        while position < len(result):
            if score > result[position][1] or (score == result[position][1] and tie_ranks[document_id] < tie_ranks[result[position][0]]):
                break
            position += 1
        if position >= result_limit:
            continue
        result.insert(position, (document_id, score))
        if len(result) > result_limit:
            result.pop()
    return result


def _queries(vocabulary_size: int, query_count: int, terms_per_query: int) -> list[list[str]]:
    rng = random.Random(20261107)
    vocabulary = [f"词项{index:04d}" for index in range(vocabulary_size)]
    output: list[list[str]] = []
    for _ in range(query_count):
        output.append(list(dict.fromkeys(rng.sample(vocabulary, k=min(terms_per_query, vocabulary_size)))))
    return output


def _measure(
    search: Callable[[list[str]], list[tuple[int, float]]],
    queries: list[list[str]],
    iterations: int,
) -> list[float]:
    samples: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        for query in queries:
            search(query)
        samples.append((time.perf_counter() - started) * 1000 / len(queries))
    return samples


def _assert_equivalent(
    python_search: Callable[[list[str]], list[tuple[int, float]]],
    cython_search: Callable[[list[str]], list[tuple[int, float]]],
    queries: list[list[str]],
) -> None:
    for query in queries:
        expected = python_search(query)
        actual = cython_search(query)
        if [row[0] for row in expected] != [row[0] for row in actual]:
            raise AssertionError("Cython 与 Python BM25 Top-K 文档次序不一致")
        for (_, expected_score), (_, actual_score) in zip(expected, actual):
            if not math.isclose(expected_score, actual_score, rel_tol=1e-12, abs_tol=1e-12):
                raise AssertionError("Cython 与 Python BM25 分数超出浮点容差")


def _run_ts_baseline(
    corpus_path: Path, query_path: Path, iterations: int,
) -> dict[str, str]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("找不到 Node.js，无法运行现有 TS 基准")
    completed = subprocess.run(
        [node, "--experimental-strip-types", str(TS_BENCHMARK), str(corpus_path), str(query_path), str(iterations)],
        check=True,
        capture_output=True,
        text=True,
    )
    return {
        key: value
        for line in completed.stdout.splitlines()
        if "=" in line
        for key, value in [line.split("=", 1)]
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="比较合成 RAG BM25 查询的 Python、Cython 与 TS 耗时")
    parser.add_argument("--documents", type=int, default=6000)
    parser.add_argument("--vocabulary", type=int, default=4000)
    parser.add_argument("--terms-per-document", type=int, default=36)
    parser.add_argument("--queries", type=int, default=120)
    parser.add_argument("--terms-per-query", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    if min(args.documents, args.vocabulary, args.terms_per_document, args.queries, args.terms_per_query, args.iterations) < 1:
        parser.error("所有规模和迭代数必须大于 0")

    try:
        # Python 3.12+ no longer bundles distutils; setuptools installs its shim.
        import setuptools  # noqa: F401
        import pyximport
    except ImportError:
        print("缺少 Cython 或 setuptools。请在隔离的开发环境安装后重跑；本脚本不会修改项目依赖。", file=sys.stderr)
        return 2

    source_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(source_dir))
    sys.path.insert(0, str(REPO_ROOT / "backend"))
    documents = _build_corpus(args.documents, args.vocabulary, args.terms_per_document)
    queries = _queries(args.vocabulary, args.queries, args.terms_per_query)
    build_started = time.perf_counter()
    lengths, postings, average_length = _build_index(documents)
    python_index_build_ms = (time.perf_counter() - build_started) * 1000
    try:
        with tempfile.TemporaryDirectory(prefix="gugu-cython-rag-build-") as build_dir:
            cython_compile_started = time.perf_counter()
            pyximport.install(build_dir=build_dir, language_level=3)
            from agent.rag.cython_backend import build_index as build_cython_index
            from agent.rag.cython_backend import search as cython_bm25_search
            # build_index 会首次导入/编译数据构建内核；提前导入，避免把扩展编译
            # 时间误计入冷建索引阶段。
            from agent.rag import cython_native  # noqa: F401
            from agent.rag.cython_kernel import cosine_scores, idf_rescore

            cosine_rows = cosine_scores(
                array("d", [1.0, 0.0]),
                array("d", [1.0, 0.0, 0.0, 1.0, 9.0]),
                array("i", [0, 2, 4, 5, 5]),
                array("i", [2, 2, 1, 0]),
            )
            if cosine_rows != [(0, 1.0), (1, 0.0), (2, 0.0)]:
                raise AssertionError("Cython cosine 与 TS 空间不匹配/零向量规则不一致")
            baseline, indexed_idfs, contributions = idf_rescore(
                array("i", [2, 1, -1]), array("i", [3, 0, 2]), 5, 8.0, 5,
            )
            expected_idfs = [
                math.log(1.0 + (5 - 2 + 0.5) / (2 + 0.5)),
                math.log(1.0 + (5 - 1 + 0.5) / (1 + 0.5)),
            ]
            expected_baseline = sum(expected_idfs) / 2
            term_idf = expected_idfs[0]
            query_weight = max(0.25, min(4.0, term_idf / expected_baseline))
            norm = 3 + 1.2 * (1.0 - 0.75 + 0.75 * 5 / 8.0)
            weighted = term_idf * 3 * 2.2 / norm * query_weight
            expected_nonlinear = weighted ** 1.5
            if not math.isclose(baseline, expected_baseline, rel_tol=1e-12, abs_tol=1e-12):
                raise AssertionError("Cython IDF baseline 与 Python 参考不一致")
            if indexed_idfs != [(0, expected_idfs[0]), (1, expected_idfs[1])]:
                raise AssertionError("Cython IDF 索引词项与 Python 参考不一致")
            if len(contributions) != 1 or not math.isclose(
                contributions[0][5], expected_nonlinear, rel_tol=1e-12, abs_tol=1e-12,
            ):
                raise AssertionError("Cython IDF 非线性贡献与 Python 参考不一致")

            cython_compile_ms = (time.perf_counter() - cython_compile_started) * 1000
            flatten_started = time.perf_counter()
            cython_index = build_cython_index(documents)
            cython_input_build_ms = (time.perf_counter() - flatten_started) * 1000

            def python_search(query: list[str]) -> list[tuple[int, float]]:
                return _python_search(lengths, postings, average_length, query, 10)

            def python_csr_search(query: list[str]) -> list[tuple[int, float]]:
                query_ids = [cython_index.term_ids.get(term, -1) for term in query]
                return _python_csr_search(
                    cython_index.document_lengths, cython_index.term_offsets,
                    cython_index.posting_document_ids, cython_index.posting_frequencies,
                    cython_index.document_frequencies, cython_index.document_tie_ranks,
                    query_ids, cython_index.average_length, 10,
                )

            def cython_search(query: list[str]) -> list[tuple[int, float]]:
                return cython_bm25_search(cython_index, query, 10)

            _assert_equivalent(python_search, cython_search, queries)
            _assert_equivalent(python_csr_search, cython_search, queries)
            _measure(python_search, queries[:min(5, len(queries))], 2)
            _measure(python_csr_search, queries[:min(5, len(queries))], 2)
            _measure(cython_search, queries[:min(5, len(queries))], 2)
            python_samples = _measure(python_search, queries, args.iterations)
            python_csr_samples = _measure(python_csr_search, queries, args.iterations)
            cython_samples = _measure(cython_search, queries, args.iterations)

            with tempfile.TemporaryDirectory(prefix="gugu-cython-rag-data-") as data_dir:
                data_root = Path(data_dir)
                corpus_path = data_root / "corpus.tsv"
                query_path = data_root / "queries.txt"
                corpus_path.write_text(
                    "".join(f"{doc_id}\t{' '.join(terms)}\n" for doc_id, terms in enumerate(documents)),
                    encoding="utf-8",
                )
                query_path.write_text("".join(" ".join(query) + "\n" for query in queries), encoding="utf-8")
                ts = _run_ts_baseline(corpus_path, query_path, args.iterations)

            python_mean = statistics.mean(python_samples)
            python_csr_mean = statistics.mean(python_csr_samples)
            cython_mean = statistics.mean(cython_samples)
            print(f"合成语料：documents={args.documents} terms_per_document={args.terms_per_document} vocabulary={args.vocabulary}")
            print(f"查询集：queries={args.queries} terms_per_query={args.terms_per_query} top_k=10 iterations={args.iterations}")
            print(f"索引构建：python_map={python_index_build_ms:.3f} ms cython_csr_conversion={cython_input_build_ms:.3f} ms")
            print(f"Cython 首次编译/导入：{cython_compile_ms:.3f} ms（单独列出，不计入 warm query）")
            print(f"Python warm query：mean={python_mean:.4f} ms/query p50={_percentile(python_samples, .50):.4f} p95={_percentile(python_samples, .95):.4f}")
            print(f"Python CSR warm query：mean={python_csr_mean:.4f} ms/query p50={_percentile(python_csr_samples, .50):.4f} p95={_percentile(python_csr_samples, .95):.4f}")
            print(f"Cython warm query：mean={cython_mean:.4f} ms/query p50={_percentile(cython_samples, .50):.4f} p95={_percentile(cython_samples, .95):.4f}")
            print(f"Cython/Python map 实现 speedup：{python_mean / cython_mean:.2f}x（含数据布局差异）")
            print(f"Cython/Python 同 CSR 内核 speedup：{python_csr_mean / cython_mean:.2f}x")
            ts_mean = float(ts.get("ts_warm_query_mean_ms", "nan"))
            print(f"TS 现有基准：cold_build_mean={ts.get('ts_cold_mean_ms', 'n/a')} ms warm_query_mean={ts.get('ts_warm_query_mean_ms', 'n/a')} ms/query p50={ts.get('ts_warm_query_p50_ms', 'n/a')} p95={ts.get('ts_warm_query_p95_ms', 'n/a')}")
            if math.isfinite(ts_mean) and cython_mean > 0:
                print(f"Cython/TS warm-query speedup（仅量级参考）：{ts_mean / cython_mean:.2f}x")
            print("一致性：所有合成查询的 Python/Cython Top-K 顺序一致，分数容差 1e-12")
            print("说明：TS 基准使用仓库现有 bench_rag_bm25.ts；它与本原型共享合成语料，但索引容器不同，结果用于量级参考，不代表生产端到端收益。")
    except Exception as exc:
        print(f"Cython 原型运行失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
