#!/usr/bin/env python3
"""在明确授权的单用户真实语料上比较 TS 与 Cython BM25。

只读加载用户 RAG 来源；临时 TS 索引和 Cython 索引仅驻留于本进程/临时目录。
查询从用户真实文档标题派生，报告仅输出聚合数字，不打印账号、标题、正文或查询。
本基准只验证 canonical tokenizer + lexical BM25，不代表 Hybrid / confidence-v4 全链路。
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import importlib
import json
import os
import statistics
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.rag.delta import chunk_slot_key
from agent.rag.index_builder import build_source_documents
from agent.rag.models import IndexDocument
from agent.rag.ts_sidecar import TsSidecarClient
from agent.rag.adapters.knowledge import KnowledgeAdapter
from app.core.config import get_settings
from app.db.session import dispose_engine, get_db
from agent.rag.models import Scope
from scripts.benchmarks.benchmark_rag_read_ab import DEFAULT_SOURCES


# The read benchmark's historic default also lists `file`, but File Library is
# not a canonical RAG source and its builder intentionally rejects that type.
REAL_RAG_SOURCES = tuple(source for source in DEFAULT_SOURCES if source != "file")


def _ranking_text(document: IndexDocument) -> str:
    if document.source_type == "conversation":
        # TS conversation adapter ranks every chunk against the full current
        # message, not the stored chunk body. Mirror the canonical projection.
        return str(document.metadata.get("context_current") or document.content)
    parts = [document.title]
    if document.summary and not document.content.strip().startswith(document.summary):
        parts.append(document.summary)
    parts.append(document.content)
    return "\n".join(parts)


def _queries(documents: list[IndexDocument], limit: int) -> list[tuple[str, str, str]]:
    seen: set[tuple[str, str]] = set()
    tasks: list[tuple[str, str, str]] = []
    for document in documents:
        title = (document.title or "").strip()
        key = (document.source_type, document.source_id)
        if len(title) < 3 or key in seen:
            continue
        seen.add(key)
        tasks.append((title, document.source_type, document.source_id))
        if len(tasks) >= limit:
            break
    return tasks


def _mean(values: list[float]) -> float:
    return round(statistics.mean(values), 4) if values else 0.0


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return round(ordered[round((len(ordered) - 1) * fraction)], 4)


def _peak_rss_mib(pid: int) -> float | None:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
        value = next(line.split()[1] for line in status.splitlines() if line.startswith("VmHWM:"))
        return round(int(value) / 1024, 2)
    except (OSError, StopIteration, ValueError):
        return None


async def _close_client_cleanly(client: TsSidecarClient) -> None:
    process = client._process
    try:
        if process is not None and process.returncode is None:
            if process.stdin is not None:
                process.stdin.close()
                await process.stdin.wait_closed()
            await asyncio.wait_for(process.wait(), timeout=3)
    finally:
        await client.close()
    # Asyncio Process has no public close method; explicitly release its pipe
    # transports so short-lived benchmark processes do not emit GC warnings.
    transport = getattr(process, "_transport", None) if process is not None else None
    if transport is not None:
        transport.close()
        await asyncio.sleep(0)
    del process
    gc.collect()


async def _load_sources_with_safe_stage(owner_user_id: UUID, sources: tuple[str, ...]):
    loaded: dict[str, list[IndexDocument]] = {}
    async for db in get_db():
        for source_type in sources:
            print(f"基准阶段：read_source_{source_type}", file=sys.stderr, flush=True)
            try:
                if source_type == "knowledge":
                    loaded[source_type] = await KnowledgeAdapter(owner_user_id).build_documents(
                        scope=Scope(owner_user_id=str(owner_user_id), scope_type="owner"),
                    )
                else:
                    loaded[source_type] = await build_source_documents(db, owner_user_id, source_type)
            except Exception as error:
                raise RuntimeError(
                    f"source={source_type}; error={type(error).__name__}"
                ) from None
        break
    return loaded


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    import pyximport

    # Build products stay outside the repository and user data directories.
    with tempfile.TemporaryDirectory(prefix="gugu-rag-cython-real-") as temp_dir:
        temp_root = Path(temp_dir)
        phase = "compile_cython_extension"
        print(f"基准阶段：{phase}", file=sys.stderr, flush=True)
        pyximport.install(build_dir=str(temp_root / "cython-build"), language_level=3)
        cython_backend = importlib.import_module("agent.rag.cython_backend")
        cython_compile_started = time.perf_counter()
        cython_backend._load_kernel()
        cython_compile_ms = (time.perf_counter() - cython_compile_started) * 1000
        phase = "read_user_rag_sources"
        print(f"基准阶段：{phase}", file=sys.stderr, flush=True)
        started = time.perf_counter()
        try:
            by_source = await _load_sources_with_safe_stage(
                UUID(args.owner_user_id), tuple(args.sources.split(",")),
            )
        except Exception:
            await dispose_engine()
            raise
        source_read_ms = (time.perf_counter() - started) * 1000
        documents = [document for source in by_source.values() for document in source]
        documents.sort(key=chunk_slot_key)
        tasks = _queries(documents, args.queries)
        if not documents or not tasks:
            return {"documents": len(documents), "queries": len(tasks), "note": "数据不足，未执行对比"}

        settings = get_settings().search
        client = TsSidecarClient(
            f"cython-benchmark:{uuid.uuid4().hex}",
            command=settings.ts_sidecar_command,
            index_dir=str(temp_root / "ts-index"),
        )
        try:
            phase = "build_temporary_ts_index"
            print(f"基准阶段：{phase}；文档数={len(documents)}", file=sys.stderr, flush=True)
            ts_build_started = time.perf_counter()
            await client.replace(documents, revision=f"cython-ab:{uuid.uuid4().hex}")
            ts_build_ms = (time.perf_counter() - ts_build_started) * 1000

            phase = "tokenize_canonical_documents"
            print(f"基准阶段：{phase}", file=sys.stderr, flush=True)
            token_started = time.perf_counter()
            tokenized_documents: list[list[str]] = []
            for document in documents:
                response = (await client._request({
                    "op": "tokenize", "text": _ranking_text(document),
                })).response
                tokenized_documents.append(list(response.get("tokens") or []))
            cython_build_started = time.perf_counter()
            cython_index = cython_backend.build_index(
                tokenized_documents,
                document_keys=[document.chunk_id for document in documents],
            )
            cython_index_ms = (time.perf_counter() - cython_build_started) * 1000
            tokenization_ms = (cython_build_started - token_started) * 1000

            documents_by_key = {chunk_slot_key(document): document for document in documents}
            ts_times: list[float] = []
            cython_times: list[float] = []
            overlap_at_10: list[float] = []
            top1_matches = 0
            exact_top10_matches = 0
            top10_set_matches = 0
            common_score_mismatch_count = 0
            max_common_score_delta = 0.0
            relevant_ts = 0
            relevant_cython = 0
            phase = "ab_search"
            print(f"基准阶段：{phase}；任务数={len(tasks)}", file=sys.stderr, flush=True)
            for query, source_type, source_id in tasks:
                query_tokens = list((await client._request({
                    "op": "tokenize", "text": query,
                })).response.get("tokens") or [])
                # Warm each side with the same task before recording timed samples.
                await client.search(query, documents=documents_by_key, limit=10)
                cython_backend.search(cython_index, query_tokens, limit=10)
                ts_samples: list[float] = []
                cython_samples: list[float] = []
                ts_keys: list[str] = []
                cython_keys: list[str] = []
                for _ in range(args.iterations):
                    start = time.perf_counter()
                    ts_results = await client.search(query, documents=documents_by_key, limit=10)
                    ts_samples.append((time.perf_counter() - start) * 1000)
                    start = time.perf_counter()
                    cython_results = cython_backend.search(cython_index, query_tokens, limit=10)
                    cython_samples.append((time.perf_counter() - start) * 1000)
                # Results are identical over repetitions; retain only IDs for metrics.
                ts_keys = [chunk_slot_key(result.document) for result in ts_results]
                cython_keys = [chunk_slot_key(documents[item[0]]) for item in cython_results]
                if ts_keys == cython_keys:
                    exact_top10_matches += 1
                if set(ts_keys) == set(cython_keys):
                    top10_set_matches += 1
                ts_scores = {
                    chunk_slot_key(result.document): result.score for result in ts_results
                }
                cython_scores = {
                    chunk_slot_key(documents[item[0]]): item[1] for item in cython_results
                }
                for key in ts_scores.keys() & cython_scores.keys():
                    delta = abs(ts_scores[key] - cython_scores[key])
                    max_common_score_delta = max(max_common_score_delta, delta)
                    common_score_mismatch_count += int(delta > 1e-12)
                ts_times.extend(ts_samples)
                cython_times.extend(cython_samples)
                overlap_at_10.append(
                    len(set(ts_keys) & set(cython_keys)) / max(1, len(set(ts_keys) | set(cython_keys)))
                )
                if ts_keys and cython_keys and ts_keys[0] == cython_keys[0]:
                    top1_matches += 1
                relevant_ts += int(any(
                    documents_by_key[key].source_type == source_type
                    and documents_by_key[key].source_id == source_id for key in ts_keys
                ))
                relevant_cython += int(any(
                    documents[item[0]].source_type == source_type
                    and documents[item[0]].source_id == source_id for item in cython_results
                ))
            ts_worker_peak_rss_mib = (
                _peak_rss_mib(client._process.pid)
                if client._process is not None and client._process.pid is not None
                else None
            )
        finally:
            await _close_client_cleanly(client)
            await dispose_engine()

    return {
        "scope": "single explicitly supplied account; no account identifier emitted",
        "sources": len(by_source),
        "documents": len(documents),
        "queries": len(tasks),
        "iterations_per_query": args.iterations,
        "source_read_ms": round(source_read_ms, 2),
        "ts_index_build_ms": round(ts_build_ms, 2),
        "cython_extension_compile_or_import_ms": round(cython_compile_ms, 2),
        "canonical_tokenization_ms": round(tokenization_ms, 2),
        "cython_csr_build_ms": round(cython_index_ms, 2),
        "ts_search_mean_ms": _mean(ts_times),
        "ts_search_p50_ms": _percentile(ts_times, 0.5),
        "ts_search_p95_ms": _percentile(ts_times, 0.95),
        "cython_search_mean_ms": _mean(cython_times),
        "cython_search_p50_ms": _percentile(cython_times, 0.5),
        "cython_search_p95_ms": _percentile(cython_times, 0.95),
        "warm_search_speedup": round(_mean(ts_times) / max(0.0001, _mean(cython_times)), 3),
        "ts_worker_peak_rss_mib": ts_worker_peak_rss_mib,
        "python_peak_rss_mib": _peak_rss_mib(os.getpid()),
        "top1_agreement": round(top1_matches / len(tasks), 4),
        "top10_exact_sequence_agreement": round(exact_top10_matches / len(tasks), 4),
        "top10_set_agreement": round(top10_set_matches / len(tasks), 4),
        "top10_common_candidate_score_mismatches": common_score_mismatch_count,
        "top10_max_common_candidate_score_delta": max_common_score_delta,
        "mean_top10_jaccard": round(statistics.mean(overlap_at_10), 4),
        "relevant_source_hit_at_10": {
            "ts": round(relevant_ts / len(tasks), 4),
            "cython": round(relevant_cython / len(tasks), 4),
        },
        "scope_note": "真实 canonical 语料 + 文档标题派生查询；只比较 canonical tokenizer 与 BM25，不含 hybrid、embedding、confidence 重排和权限注入。",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="单用户真实 RAG 语料上的 TS/Cython lexical A/B")
    parser.add_argument("--owner-user-id", required=True, help="须是明确授权的单用户 UUID")
    parser.add_argument("--allow-real-data", action="store_true", help="确认仅读取该账号真实 RAG 来源")
    parser.add_argument("--sources", default=",".join(REAL_RAG_SOURCES))
    parser.add_argument("--queries", type=int, default=40)
    parser.add_argument("--iterations", type=int, default=3)
    args = parser.parse_args()
    if not args.allow_real_data:
        parser.error("真实语料读取需显式指定 --allow-real-data")
    try:
        result = asyncio.run(_run(args))
    except Exception as error:
        print(f"基准失败：{type(error).__name__}；异常详情已省略以保护用户语料", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
