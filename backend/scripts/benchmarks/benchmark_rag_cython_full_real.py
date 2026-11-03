#!/usr/bin/env python3
"""在授权的 devserver 真实 owner 索引上只读比较 TS 与 Cython unified RAG。

数据库与 StorageReader 只读；TS 索引目录和编译产物位于临时目录。查询文本仅在
进程内由真实索引标题生成，不调用 embedding provider、不输出用户数据。
默认向量查询使用同版本缓存向量回放。显式 ``--real-query-embedding`` 时，最多对
5 条真实查询各请求一次 provider，并将同一向量用于 TS/Cython 对照；不生成文档向量。
"""
from __future__ import annotations

import argparse
import atexit
import asyncio
import cProfile
import gc
import hashlib
import importlib
import io
import json
import math
import os
import pstats
import shutil
import statistics
import sys
import tempfile
import time
import traceback
import uuid
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.rag.cython_lifecycle import CythonRagLifecycle
from agent.rag.delta import chunk_slot_key
from agent.rag.models import Scope
from agent.rag.ts_sidecar import TsSidecarClient
from agent.rag.cython_tokenizer import tokenize_raw
from agent.memory import embedding
from app.core.config import get_settings
from app.db.session import dispose_engine, get_db


SOURCE_ORDER = (
    "memory", "knowledge", "project", "canvas", "note",
    "calendar", "scheduled_task", "conversation",
)
RANK_OPTIONS = {
    "limit": 8,
    "max_chars": 5000,
    "max_per_source": 4,
    "max_per_parent": 3,
    "selection_mode": "confidence",
    "exclude_content_hashes": [],
}


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return round(ordered[round((len(ordered) - 1) * fraction)], 3)


def _peak_rss_mib(pid: int) -> float | None:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
        value = next(line.split()[1] for line in status.splitlines() if line.startswith("VmHWM:"))
        return round(int(value) / 1024, 2)
    except (OSError, StopIteration, ValueError):
        return None


def _current_rss_mib(pid: int) -> float | None:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
        value = next(line.split()[1] for line in status.splitlines() if line.startswith("VmRSS:"))
        return round(int(value) / 1024, 2)
    except (OSError, StopIteration, ValueError):
        return None


def _synthetic_vector(key: str) -> list[float]:
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    return [
        (int.from_bytes(digest[offset:offset + 2], "big") - 32768) / 32768
        for offset in range(0, 32, 2)
    ]


def _clean_response(response: dict[str, Any]) -> dict[str, Any]:
    result = json.loads(json.dumps(response, ensure_ascii=False, allow_nan=False))
    for key in ("version", "probe", "search_diagnostics", "_sidecar_timing"):
        result.pop(key, None)
    if isinstance(result.get("stats"), dict):
        result["stats"].pop("elapsed_ms", None)
    return result


def _same_value(left: Any, right: Any) -> bool:
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same_value(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_same_value(a, b) for a, b in zip(left, right))
    if isinstance(left, (int, float)) and not isinstance(left, bool):
        return isinstance(right, (int, float)) and not isinstance(right, bool) and math.isclose(
            float(left), float(right), rel_tol=0, abs_tol=1e-12,
        )
    return left == right


def _difference_paths(left: Any, right: Any, path: str = "response") -> set[str]:
    if isinstance(left, dict) and isinstance(right, dict):
        paths = {f"{path}.{key}" for key in left.keys() ^ right.keys()}
        for key in left.keys() & right.keys():
            paths.update(_difference_paths(left[key], right[key], f"{path}.{key}"))
        return paths
    if isinstance(left, list) and isinstance(right, list):
        paths = set()
        if len(left) != len(right):
            paths.add(f"{path}.length")
        for index, (left_item, right_item) in enumerate(zip(left, right)):
            paths.update(_difference_paths(left_item, right_item, f"{path}[{index}]"))
        return paths
    if not _same_value(left, right):
        return {path}
    return set()


def _query_tasks(
    documents, transient_documents, persistent_vectors, transient_vectors, limit,
    *, conversation_user_queries: bool = False, stratified_content_queries: bool = False,
):
    tasks = []
    seen: set[tuple[str, str]] = set()
    if conversation_user_queries:
        for document in documents:
            metadata = document.metadata
            if (document.source_type != "conversation" or metadata.get("kind") != "message"
                    or metadata.get("role") != "user"):
                continue
            current = str(metadata.get("context_current") or document.content or "").strip()
            if current.startswith("user："):
                current = current[len("user："):].strip()
            if len(current) < 3:
                continue
            identity = (document.source_type, document.source_id)
            if identity in seen:
                continue
            seen.add(identity)
            tasks.append({
                "query": current, "source": "conversation", "corpus": "persistent",
                "vector": [], "target_key": chunk_slot_key(document),
            })
            if len(tasks) >= limit:
                break
        return tasks

    source_documents: dict[str, list[tuple[str, Any, dict[str, list[float]]]]] = {}
    corpora = (
        ("persistent", documents, persistent_vectors),
        ("transient", transient_documents, transient_vectors),
    )
    for corpus, rows, vectors in corpora:
        for document in rows:
            if document.scope.scope_type != "owner":
                continue
            if stratified_content_queries and document.source_type == "memory" and corpus != "transient":
                # UnifiedQueryRetriever 对 memory 的口径是瞬态 MemoryAdapter 语料。
                continue
            title = (document.title or "").strip()
            content = str(document.metadata.get("context_current") or document.content or "").strip()
            if len(title) < 3 and len(content) < 3:
                continue
            identity = (document.source_type, document.source_id)
            if identity in seen:
                continue
            key = chunk_slot_key(document)
            vector = vectors.get(key)
            seen.add(identity)
            query = title
            if stratified_content_queries:
                # Keep only a short, in-memory excerpt. Never emit it in benchmark output.
                excerpt = " ".join(content.split())[:240]
                query = " ".join(part for part in (title, excerpt) if part).strip()[:320]
            source_documents.setdefault(document.source_type, []).append((corpus, document, {
                "vector": vector or [], "target_key": key, "query": query,
            }))

    if stratified_content_queries:
        # Round-robin sources so large sources cannot consume the whole benchmark sample.
        source_order = [source for source in SOURCE_ORDER if source_documents.get(source)]
        offsets = {source: 0 for source in source_order}
        while len(tasks) < limit:
            added = False
            for source in source_order:
                index = offsets[source]
                rows = source_documents[source]
                if index >= len(rows):
                    continue
                corpus, _document, details = rows[index]
                offsets[source] += 1
                tasks.append({"source": source, "corpus": corpus, **details})
                added = True
                if len(tasks) >= limit:
                    break
            if not added:
                break
        return tasks

    for source in SOURCE_ORDER:
        for corpus, _document, details in source_documents.get(source, []):
            tasks.append({"source": source, "corpus": corpus, **details})
            if len(tasks) >= limit:
                return tasks
    return tasks


async def _run_tokenizer_probe(args: argparse.Namespace) -> dict[str, Any]:
    import pyximport

    cython_build_dir = tempfile.mkdtemp(prefix="gugu-rag-tokenizer-cython-")
    atexit.register(shutil.rmtree, cython_build_dir, ignore_errors=True)
    pyximport.install(build_dir=cython_build_dir, language_level=3)

    from agent.rag.cython_backend import _worker_document_wire
    from agent.rag import cython_tokenizer
    from agent.rag.cython_tokenizer import tokenize_raw
    from agent.rag.cython_lifecycle import CythonRagLifecycle

    owner = UUID(args.owner_user_id)
    lifecycle = CythonRagLifecycle()
    owner_scope = Scope(owner_user_id=str(owner), scope_type="owner")
    async for db in get_db():
        await lifecycle.load_index_from_database(db, owner)
        await lifecycle.prepare_memory(owner, [owner_scope], source_filter="all")
        break
    buckets: dict[str, list] = {}
    for document in lifecycle.engine._persistent.documents:
        buckets.setdefault(document.source_type, []).append(document)
    for document in lifecycle.engine._transient.documents:
        buckets.setdefault(f"transient_{document.source_type}", []).append(document)
    samples = []
    total_documents = sum(len(documents) for documents in buckets.values())
    if args.tokenizer_samples >= total_documents:
        samples = [document for source in sorted(buckets) for document in buckets[source]]
    else:
        per_source = max(1, args.tokenizer_samples // max(1, len(buckets)))
        for source in sorted(buckets):
            samples.extend(buckets.get(source, ())[:per_source])
        samples = samples[:args.tokenizer_samples]
    settings = get_settings().search
    with tempfile.TemporaryDirectory(prefix="gugu-rag-tokenizer-probe-") as temp_dir:
        client = TsSidecarClient(
            f"tokenizer-probe:{uuid.uuid4().hex}", command=settings.ts_sidecar_command,
            index_dir=temp_dir,
        )
        exact = 0
        ts_tokenize_request_ms = 0.0
        wire_texts: list[str] = []
        token_count_deltas = []
        source_counts: dict[str, dict[str, int]] = {}
        token_stats: dict[str, dict[str, Any]] = {}
        try:
            for document in samples:
                source = document.source_type
                counts = source_counts.setdefault(source, {"samples": 0, "exact": 0})
                counts["samples"] += 1
                wire_document = _worker_document_wire(document, chunk_slot_key(document))
                wire_text = str(wire_document.get("ranking_text") or wire_document.get("text") or "")
                wire_texts.append(wire_text)
                tokenize_started = time.perf_counter()
                ts_tokens = (await client._request({"op": "tokenize", "text": wire_text})).response.get("tokens") or []
                ts_tokenize_request_ms += (time.perf_counter() - tokenize_started) * 1000
                py_tokens = tokenize_raw(wire_text)
                stats = token_stats.setdefault(source, {
                    "documents": 0, "ts_total_tokens": 0, "cython_total_tokens": 0,
                    "ts_df": Counter(), "cython_df": Counter(), "token_sequence_mismatches": 0,
                })
                stats["documents"] += 1
                stats["ts_total_tokens"] += len(ts_tokens)
                stats["cython_total_tokens"] += len(py_tokens)
                stats["ts_df"].update(set(map(str, ts_tokens)))
                stats["cython_df"].update(set(map(str, py_tokens)))
                stats["token_sequence_mismatches"] += int(list(ts_tokens) != list(py_tokens))
                same = list(ts_tokens) == list(py_tokens)
                exact += int(same)
                counts["exact"] += int(same)
                token_count_deltas.append(abs(len(ts_tokens) - len(py_tokens)))
        finally:
            await _close_client(client)
    original_segmenter = cython_tokenizer._segment_chinese
    rust_pipeline_samples: list[float] = []
    for _ in range(3):
        original_segmenter.cache_clear()
        started = time.perf_counter()
        [tokenize_raw(text) for text in wire_texts]
        rust_pipeline_samples.append((time.perf_counter() - started) * 1000)
    await dispose_engine()
    aggregate_token_stats = {}
    for source, stats in token_stats.items():
        ts_df = stats["ts_df"]
        cython_df = stats["cython_df"]
        shared_terms = ts_df.keys() & cython_df.keys()
        aggregate_token_stats[source] = {
            "documents": stats["documents"],
            "ts_average_token_length": round(stats["ts_total_tokens"] / max(1, stats["documents"]), 3),
            "cython_average_token_length": round(stats["cython_total_tokens"] / max(1, stats["documents"]), 3),
            "token_sequence_mismatches": stats["token_sequence_mismatches"],
            "ts_unique_terms": len(ts_df),
            "cython_unique_terms": len(cython_df),
            "df_exact_term_agreement": round(
                sum(ts_df[term] == cython_df[term] for term in shared_terms)
                / max(1, len(ts_df.keys() | cython_df.keys())), 6,
            ),
            "df_absolute_delta_sum": sum(
                abs(ts_df.get(term, 0) - cython_df.get(term, 0))
                for term in ts_df.keys() | cython_df.keys()
            ),
        }
    return {
        "status": "completed", "sampled_documents": len(samples),
        "persistent_documents": len(lifecycle.engine._persistent.documents),
        "transient_documents": len(lifecycle.engine._transient.documents),
        "exact_token_sequence_agreement": round(exact / max(1, len(samples)), 6),
        "ts_tokenize_request_total_ms": round(ts_tokenize_request_ms, 3),
        "rjieba_full_cython_tokenizer": {
            "rjieba_p50_ms": _percentile(rust_pipeline_samples, 0.5),
        },
        "mean_absolute_token_count_delta": round(statistics.mean(token_count_deltas), 4) if token_count_deltas else 0,
        "sources": source_counts,
        "per_source_token_and_df_stats": aggregate_token_stats,
        "scope_note": "对相同真实 wire 文本比较 TS 与 Cython token 序列；Cython 全语料重复计时会清空段缓存。TS tokenize 含 sidecar IPC；只输出聚合值，不输出真实文本。",
    }


async def _close_client(client: TsSidecarClient) -> None:
    process = client._process
    try:
        await client.close()
    finally:
        transport = getattr(process, "_transport", None) if process is not None else None
        if transport is not None and not transport._closed:
            transport.close()
            # subprocess.wait() 只等进程退出，不保证 stdout/stderr/stdin
            # transport 的 connection_lost 回调已完成。若 asyncio.run 随即
            # 关闭 loop，transport 析构会尝试向已关闭 loop 调度 write_eof。
            for _ in range(100):
                pipes = getattr(transport, "_pipes", None) or {}
                if all(pipe is None or pipe.disconnected for pipe in pipes.values()):
                    break
                await asyncio.sleep(0.01)
    gc.collect()


async def _run_with_sidecar_cleanup(args: argparse.Namespace) -> dict[str, Any]:
    """关闭本次基准触发的显式及缓存 TS worker，避免 asyncio.run 遗留子进程。"""
    try:
        return await (_run_tokenizer_probe(args) if args.tokenizer_sample_only else _run(args))
    finally:
        from agent.rag.ts_sidecar import (
            _lexical_clients,
            _rank_clients,
            close_lexical_clients,
            close_rank_clients,
        )

        loop = asyncio.get_running_loop()
        clients = list((_lexical_clients.get(loop) or {}).values())
        rank_client = _rank_clients.get(loop)
        if rank_client is not None:
            clients.append(rank_client)
        if clients:
            await asyncio.gather(*(_close_client(client) for client in clients), return_exceptions=True)
        # 清空 client registry 与 idle-reaper 任务；上面已额外收拢 subprocess pipe transports。
        await close_lexical_clients()
        await close_rank_clients()


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    import pyximport
    import agent.rag.cython_lifecycle as lifecycle_module

    owner = UUID(args.owner_user_id)
    python_startup_rss = _current_rss_mib(os.getpid())
    with tempfile.TemporaryDirectory(prefix="gugu-rag-cython-full-") as temporary:
        root = Path(temporary)
        compile_started = time.perf_counter()
        build_dir = os.environ.get("GUGU_CYTHON_BUILD_DIR") or str(root / "cython-build")
        pyximport.install(build_dir=build_dir, language_level=3)
        cython_module = importlib.import_module("agent.rag.cython_backend")
        cython_module._load_kernel()
        tokenize_raw("")  # 将生产启动后常驻的 Jieba 词典计入 Python runtime baseline。
        cython_compile_ms = (time.perf_counter() - compile_started) * 1000
        gc.collect()
        python_baseline_rss = _current_rss_mib(os.getpid())
        lifecycle = CythonRagLifecycle()
        load_phases: dict[str, float] = {}
        original_snapshot_loader = lifecycle_module.load_rag_index_snapshot

        async def timed_snapshot_loader(*loader_args, **loader_kwargs):
            started = time.perf_counter()
            try:
                return await original_snapshot_loader(*loader_args, **loader_kwargs)
            finally:
                load_phases["database_snapshot_ms"] = (time.perf_counter() - started) * 1000

        lifecycle_module.load_rag_index_snapshot = timed_snapshot_loader
        original_replace = lifecycle.engine.replace

        def timed_index_replace(*replace_args, **replace_kwargs):
            started = time.perf_counter()
            try:
                return original_replace(*replace_args, **replace_kwargs)
            finally:
                load_phases["index_build_install_ms"] = (time.perf_counter() - started) * 1000

        lifecycle.engine.replace = timed_index_replace
        original_vector_reader = lifecycle._read_vectors

        async def timed_vector_reader(*reader_args, **reader_kwargs):
            started = time.perf_counter()
            try:
                return await original_vector_reader(*reader_args, **reader_kwargs)
            finally:
                load_phases["cached_vector_read_ms"] = (time.perf_counter() - started) * 1000

        lifecycle._read_vectors = timed_vector_reader
        from app.byok.service import resolve_and_bind_user_embedding
        async for db in get_db():
            # 真实用户 A/B 必须与请求链路一致：先解析并绑定该 owner 的 BYOK
            # embedding 配置，再读取模型版本/向量缓存；仅在当前 benchmark 进程生效。
            await resolve_and_bind_user_embedding(get_settings(), db, owner)
            vector_version = embedding.model_tag() if embedding.is_enabled() else ""
            cython_index_started = time.perf_counter()
            index_result = await lifecycle.load_index_from_database(
                db, owner, vector_version=vector_version,
            )
            cython_full_rebuild_ms = (time.perf_counter() - cython_index_started) * 1000
            persistent_revision = str(index_result.get("revision") or "")
            initial_persistent_revision = persistent_revision
            persistent_documents = lifecycle.engine._persistent.documents
            if not persistent_revision:
                return {"status": "no_index_revision", "documents": len(persistent_documents)}
            slot_counts = Counter(chunk_slot_key(document) for document in persistent_documents)
            duplicate_slots = sum(count - 1 for count in slot_counts.values() if count > 1)
            break

        # 同一临时目录先写入一次完整快照，再模拟下一次进程冷启动：轻量查 revision，
        # 校验 owner snapshot 并恢复，而不是重复读取/分词全部数据库文档。
        snapshot_dir = root / "cython-index-snapshot"
        snapshot_save_started = time.perf_counter()
        lifecycle.persist_snapshot(snapshot_dir, owner)
        cython_snapshot_save_ms = (time.perf_counter() - snapshot_save_started) * 1000
        cython_snapshot_bytes = (snapshot_dir / "index.json").stat().st_size
        snapshot_lifecycle = CythonRagLifecycle()
        async for db in get_db():
            snapshot_restore_started = time.perf_counter()
            snapshot_result = await snapshot_lifecycle.load_index_from_snapshot_or_database(
                db, owner, snapshot_dir, vector_version=vector_version,
            )
            cython_snapshot_restore_ms = (time.perf_counter() - snapshot_restore_started) * 1000
            break
        if not snapshot_result.get("snapshot_hit"):
            raise RuntimeError("fresh Cython snapshot was not accepted for the same owner revision")
        # The account may legitimately mutate while the benchmark prepares and restores.
        # Use the revision actually accepted by the restored engine, not the earlier read.
        persistent_revision = str(snapshot_result.get("revision") or lifecycle.engine.revision)
        snapshot_revision_changed = persistent_revision != initial_persistent_revision
        lifecycle = snapshot_lifecycle
        cython_index_load_ms = cython_snapshot_restore_ms
        persistent_documents = lifecycle.engine._persistent.documents
        persistent_vectors = lifecycle.engine._vectors
        transient_vectors = lifecycle.engine._transient_vectors
        storage_vector_version = vector_version

        owner_scope = Scope(owner_user_id=str(owner), scope_type="owner")
        memory_started = time.perf_counter()
        memory_prepare_profile: list[dict[str, Any]] | None = None
        memory_phase_timings: dict[str, float] = {}
        memory_phase_capture_enabled = [args.probe_memory_phases]
        if args.probe_memory_phases:
            from agent.rag import cython_native
            from agent.rag import cython_backend
            from agent.rag.adapters.memory import MemoryAdapter

            def timed_method(target, method_name: str, phase_name: str) -> None:
                original = getattr(target, method_name)

                async def wrapped(*method_args, **method_kwargs):
                    started = time.perf_counter()
                    try:
                        return await original(*method_args, **method_kwargs)
                    finally:
                        if memory_phase_capture_enabled[0]:
                            memory_phase_timings[phase_name] = (
                                memory_phase_timings.get(phase_name, 0.0)
                                + (time.perf_counter() - started) * 1000
                            )

                setattr(target, method_name, wrapped)

            def timed_sync(target, method_name: str, phase_name: str) -> None:
                original = getattr(target, method_name)

                def wrapped(*method_args, **method_kwargs):
                    started = time.perf_counter()
                    try:
                        return original(*method_args, **method_kwargs)
                    finally:
                        if memory_phase_capture_enabled[0]:
                            memory_phase_timings[phase_name] = (
                                memory_phase_timings.get(phase_name, 0.0)
                                + (time.perf_counter() - started) * 1000
                            )

                setattr(target, method_name, wrapped)

            timed_method(MemoryAdapter, "build_cached_owner_documents", "source_document_load_ms")
            timed_method(lifecycle, "_read_vectors", "vector_read_and_mapping_ms")
            timed_sync(cython_native, "memory_revision", "revision_hash_ms")
            timed_sync(lifecycle_module, "_worker_vector_map", "vector_slot_mapping_ms")
            timed_sync(lifecycle.engine, "replace_transient", "transient_index_install_ms")
            # transient_index_install 包含分词、CSR posting 构建及向量状态安装；
            # 以下细分只在显式探针时启用，估算 CSR 自身时扣除它内部触发的文本投影/分词。
            timed_sync(cython_native, "ranking_text_many", "index_text_projection_ms")
            timed_sync(cython_native, "tokenize_many", "index_tokenization_ms")
            timed_sync(cython_native, "build_csr", "index_csr_build_inclusive_ms")
            timed_sync(
                cython_backend, "_build_index_from_token_stream",
                "index_token_stream_to_csr_ms",
            )
        if args.profile_memory_prepare:
            profiler = cProfile.Profile()
            profiler.enable()
            try:
                transient = await lifecycle.prepare_memory(
                    owner, [owner_scope], source_filter="all",
                    snapshot_revision=persistent_revision, vector_version=vector_version,
                )
            finally:
                profiler.disable()
            stats = pstats.Stats(profiler).strip_dirs().sort_stats("cumtime")
            memory_prepare_profile = [
                {"function": f"{filename}:{line}:{name}", "calls": calls,
                 "cumulative_ms": round(cumulative * 1000, 3)}
                for (filename, line, name), (primitive, calls, total, cumulative, callers)
                in list(stats.stats.items())
            ]
            memory_prepare_profile.sort(key=lambda row: row["cumulative_ms"], reverse=True)
            memory_prepare_profile = memory_prepare_profile[:20]
        else:
            transient = await lifecycle.prepare_memory(
                owner, [owner_scope], source_filter="all",
                snapshot_revision=persistent_revision, vector_version=vector_version,
            )
        memory_phase_capture_enabled[0] = False
        memory_prepare_ms = (time.perf_counter() - memory_started) * 1000
        cython_memory_warm_samples: list[float] = []
        for _ in range(args.memory_prepare_repeats):
            warm_started = time.perf_counter()
            await lifecycle.prepare_memory(
                owner, [owner_scope], source_filter="all",
                snapshot_revision=persistent_revision, vector_version=vector_version,
            )
            cython_memory_warm_samples.append((time.perf_counter() - warm_started) * 1000)
        persistent = lifecycle.engine._persistent.documents
        transient_documents = lifecycle.engine._transient.documents
        persistent_vectors = lifecycle.engine._vectors
        transient_vectors = lifecycle.engine._transient_vectors
        transient_slot_counts = Counter(chunk_slot_key(document) for document in transient_documents)
        duplicate_transient_slots = sum(count - 1 for count in transient_slot_counts.values() if count > 1)
        persistent_memory_slots = {
            chunk_slot_key(document) for document in persistent
            if document.source_type == "memory"
        }
        transient_memory_slots = {
            chunk_slot_key(document) for document in transient_documents
            if document.source_type == "memory"
        }
        cross_corpus_memory_slot_collisions = len(persistent_memory_slots & transient_memory_slots)
        cached_persistent_vector_count = len(persistent_vectors)
        cached_transient_vector_count = len(transient_vectors)
        if args.synthetic_vector_replay:
            vector_version = "synthetic-replay-v1"
            persistent_vectors = {
                chunk_slot_key(document): _synthetic_vector(chunk_slot_key(document))
                for document in persistent
            }
            transient_vectors = {
                chunk_slot_key(document): _synthetic_vector(chunk_slot_key(document))
                for document in transient_documents
            }
            lifecycle.engine.set_vectors(persistent_vectors, vector_version)
            lifecycle.engine._transient_vectors = transient_vectors
            lifecycle.engine._transient_vector_version = vector_version
        python_index_rss = _current_rss_mib(os.getpid())
        tasks = _query_tasks(
            persistent, transient_documents, persistent_vectors, transient_vectors, args.queries,
            conversation_user_queries=args.conversation_user_queries,
            stratified_content_queries=args.stratified_content_queries,
        )
        if not tasks:
            return {"status": "no_queryable_documents", "documents": len(persistent)}
        query_embedding_settings = None
        if args.real_query_embedding:
            query_embedding_settings = embedding.query_settings()
            if query_embedding_settings is None:
                raise RuntimeError("真实 query embedding 当前未配置或未通过安全校验")
            # 防止 benchmark 进程内的 5 分钟缓存令“小样本”意外不触发 provider。
            embedding._query_vector_cache.clear()

        settings = get_settings().search
        client = TsSidecarClient(
            owner, command=settings.ts_sidecar_command,
            index_dir=str(root / "ts-index"),
        )
        benchmark_stage = "ts_worker_startup"
        try:
            ts_worker_started = time.perf_counter()
            await client._request({"op": "ping"})
            ts_worker_start_ms = (time.perf_counter() - ts_worker_started) * 1000

            benchmark_stage = "ts_database_cold_load"
            ts_load_started = time.perf_counter()
            ts_load_response = await client.load_index_from_database(
                owner, persistent_revision, vector_version=storage_vector_version,
            )
            ts_load_ms = (time.perf_counter() - ts_load_started) * 1000
            benchmark_stage = "ts_transient_memory_prepare"
            ts_memory_started = time.perf_counter()
            ts_transient_response = await client.prepare_memory(
                owner, [owner_scope], source_filter="all",
                snapshot_revision=persistent_revision, vector_version=storage_vector_version,
            )
            ts_memory_prepare_ms = (time.perf_counter() - ts_memory_started) * 1000
            ts_memory_warm_samples: list[float] = []
            for _ in range(args.memory_prepare_repeats):
                warm_started = time.perf_counter()
                await client.prepare_memory(
                    owner, [owner_scope], source_filter="all",
                    snapshot_revision=persistent_revision, vector_version=storage_vector_version,
                )
                ts_memory_warm_samples.append((time.perf_counter() - warm_started) * 1000)
            ts_worker_build_phases = list(client._build_probe_events)
            ts_transient_revision = str(ts_transient_response.get("transient_revision") or "")

            # 两端必须从同一 owner/revision 独立读取数据库。transient revision
            # 是各自实现的本地校验令牌，不要求哈希编码相同；语料等价由文档数
            # 和后续逐查询结果比较验证。合成向量回放时，缓存向量计数仅作诊断。
            if str(ts_load_response.get("revision") or "") != persistent_revision:
                raise RuntimeError("TS/Cython 持久索引 revision 不一致")
            if int(ts_load_response.get("document_count") or 0) != len(persistent):
                raise RuntimeError("TS/Cython 持久文档数不一致")
            if (
                not args.synthetic_vector_replay
                and int(ts_load_response.get("vector_count") or 0) != cached_persistent_vector_count
            ):
                raise RuntimeError("TS/Cython 持久缓存向量数不一致")
            if int(ts_transient_response.get("document_count") or 0) != len(transient_documents):
                raise RuntimeError("TS/Cython transient memory 文档数不一致")
            if (
                not args.synthetic_vector_replay
                and int(ts_transient_response.get("vector_count") or 0) != cached_transient_vector_count
            ):
                raise RuntimeError("TS/Cython transient memory 缓存向量数不一致")

            if args.synthetic_vector_replay:
                # 先完成并校验双方真实冷加载，再给两端注入相同的合成向量，
                # 仅用于可重复验证 Hybrid/RRF；不计入各自数据库冷加载耗时。
                benchmark_stage = "synthetic_persistent_vector_replay"
                await client.set_vectors(persistent_vectors, vector_version)
                benchmark_stage = "synthetic_transient_vector_replay"
                await client.replace_transient(
                    transient_documents, ts_transient_revision,
                    vectors=transient_vectors, vector_version=vector_version, force=True,
                )

            benchmark_stage = "query_and_rank_comparison"
            searches = [
                {"id": str(index), "source_types": [source], "limit": args.candidate_limit,
                 **({"corpus": "transient"} if source == "memory" else {}),
                 **({"scope": {"scope_type": "owner", "scope_id": ""}}
                    if source != "memory" else {})}
                for index, source in enumerate(SOURCE_ORDER)
            ]
            cython_searches = [
                {"source_types": {source}, "limit": args.candidate_limit,
                 **({"corpus": "transient"} if source == "memory" else {}),
                 **({"scope": owner_scope} if source != "memory" else {})}
                for source in SOURCE_ORDER
            ]
            ts_samples: list[float] = []
            cython_samples: list[float] = []
            exact_matches = 0
            topk_matches = 0
            topk_jaccard_total = 0.0
            topk_jaccard_by_source: dict[str, list[float]] = {}
            score_deltas: list[float] = []
            rank_score_deltas: list[float] = []
            vector_query_count = 0
            fallback_matches = 0
            query_token_matches = 0
            source_hits_ts = 0
            source_hits_cython = 0
            source_task_counts: Counter[str] = Counter(task["source"] for task in tasks)
            target_candidate_hits_ts: Counter[str] = Counter()
            target_candidate_hits_cython: Counter[str] = Counter()
            target_selected_hits_ts: Counter[str] = Counter()
            target_selected_hits_cython: Counter[str] = Counter()
            mismatch_task_source_counts: Counter[str] = Counter()
            idf_term_comparisons = 0
            idf_term_matches = 0
            ts_inferred_document_counts: list[float] = []
            from agent.rag.cython_backend import _merged_statistics
            lexical_stats = _merged_statistics([
                lifecycle.engine._persistent.bm25, lifecycle.engine._transient.bm25,
            ])
            lexical_comparisons = 0
            lexical_order_matches = 0
            lexical_score_deltas: list[float] = []
            lexical_by_source: dict[str, dict[str, Any]] = {}
            memory_wire_mismatches: Counter[str] = Counter()
            memory_wire_mismatches_by_source: Counter[str] = Counter()
            memory_wire_shared = 0
            failure_categories: dict[str, int] = {}
            mismatch_fields: dict[str, int] = {}
            query_embedding_provider_calls = 0
            query_embedding_outcomes: Counter[str] = Counter()
            profile_summary: list[dict[str, Any]] | None = None
            for task in tasks:
                query_vector = [] if args.bm25_only else task["vector"]
                if query_embedding_settings is not None:
                    embedded = await embedding.embed_query(
                        task["query"], settings=query_embedding_settings,
                    )
                    query_embedding_provider_calls += int(embedded.get("outcome") != "invalid_config")
                    query_embedding_outcomes[str(embedded.get("outcome") or "unknown")] += 1
                    query_vector = embedded.get("vector") or []
                for source in SOURCE_ORDER:
                    scope_wire = {"scope_type": "owner", "scope_id": ""} if source != "memory" else None
                    if source == "memory":
                        ts_lexical = await client._request({
                            "op": "batch_search", "revision": persistent_revision,
                            "transient_revision": ts_transient_revision,
                            "query": task["query"], "searches": [{
                                "id": "transient-probe", "corpus": "transient",
                                "source_types": [source], "limit": args.candidate_limit,
                            }],
                        })
                        ts_rows = (ts_lexical.response.get("batches") or [{}])[0].get("results") or []
                    else:
                        ts_lexical = await client._request({
                            "op": "search", "revision": persistent_revision, "query": task["query"],
                            "limit": args.candidate_limit, "source_types": [source],
                            **({"scope": scope_wire} if scope_wire else {}),
                        })
                        ts_rows = ts_lexical.response.get("results") or []
                    lexical_index = lifecycle.engine._transient if source == "memory" else lifecycle.engine._persistent
                    py_lexical, _ = lexical_index.search(
                        task["query"], limit=args.candidate_limit, source_types=[source],
                        scope=owner_scope if source != "memory" else None,
                    )
                    py_rows = py_lexical
                    ts_keys = [str(row.get("id") or "") for row in ts_rows]
                    py_keys = [chunk_slot_key(row.document) for row in py_rows]
                    if source == task["source"] and (source != "memory" or task["corpus"] == "transient"):
                        target_candidate_hits_ts[source] += int(task["target_key"] in ts_keys)
                        target_candidate_hits_cython[source] += int(task["target_key"] in py_keys)
                    lexical_comparisons += 1
                    lexical_order_matches += int(ts_keys == py_keys)
                    source_metrics = lexical_by_source.setdefault(source, {
                        "comparisons": 0, "order_matches": 0, "max_score_delta": 0.0,
                        "matched_keys": 0, "max_matched_key_score_delta": 0.0,
                        "same_candidate_set": 0, "same_score_sequence": 0,
                        "tie_order_mismatches": 0,
                    })
                    source_metrics["comparisons"] += 1
                    source_metrics["order_matches"] += int(ts_keys == py_keys)
                    same_candidate_set = set(ts_keys) == set(py_keys)
                    source_metrics["same_candidate_set"] += int(same_candidate_set)
                    same_score_sequence = len(ts_rows) == len(py_rows) and all(
                        math.isclose(float(ts_row.get("score") or 0), py_row.score,
                                     rel_tol=0, abs_tol=1e-12)
                        for ts_row, py_row in zip(ts_rows, py_rows)
                    )
                    source_metrics["same_score_sequence"] += int(same_score_sequence)
                    source_metrics["tie_order_mismatches"] += int(
                        ts_keys != py_keys and same_candidate_set and same_score_sequence
                    )
                    for ts_row, py_row in zip(ts_rows, py_rows):
                        delta = abs(float(ts_row.get("score") or 0) - py_row.score)
                        lexical_score_deltas.append(delta)
                        source_metrics["max_score_delta"] = max(source_metrics["max_score_delta"], delta)
                    ts_scores = {str(row.get("id") or ""): float(row.get("score") or 0) for row in ts_rows}
                    py_scores = {chunk_slot_key(row.document): row.score for row in py_rows}
                    shared = ts_scores.keys() & py_scores.keys()
                    if source == "memory":
                        from agent.rag.cython_backend import _worker_document_wire
                        ts_documents = {str(row.get("id") or ""): row.get("document") or {} for row in ts_rows}
                        py_documents = {chunk_slot_key(row.document): row.document for row in py_rows}
                        for key in shared:
                            left = _worker_document_wire(py_documents[key], key)
                            right = ts_documents[key]
                            memory_wire_shared += 1
                            for field in ("text", "title", "summary", "content", "updated_at", "metadata", "scope_id", "source_id"):
                                if not _same_value(left.get(field), right.get(field)):
                                    memory_wire_mismatches[field] += 1
                                    source_id = str(right.get("source_id") or "")
                                    category = source_id if source_id in {"daily", "profile", "pattern", "memory"} else "other"
                                    memory_wire_mismatches_by_source[f"{category}.{field}"] += 1
                    source_metrics["matched_keys"] += len(shared)
                    if shared:
                        source_metrics["max_matched_key_score_delta"] = max(
                            source_metrics["max_matched_key_score_delta"],
                            max(abs(ts_scores[key] - py_scores[key]) for key in shared),
                        )
                ts_query_tokens = (await client._request({
                    "op": "tokenize", "text": task["query"],
                })).response.get("tokens") or []
                query_token_matches += int(list(ts_query_tokens) == tokenize_raw(task["query"]))
                vector_query_count += int(bool(query_vector))
                ts_payload = {
                    "op": "unified_query", "revision": persistent_revision,
                    "transient_revision": ts_transient_revision,
                    "query": task["query"], "searches": searches,
                    "source_order": list(SOURCE_ORDER),
                    "candidate_limit": args.candidate_limit, "rank": RANK_OPTIONS,
                    "query_vector": query_vector, "vector_version": vector_version,
                }
                warm_ts = await client._request(ts_payload)
                if args.profile_one_query and profile_summary is None:
                    profiler = cProfile.Profile()
                    warm_py = profiler.runcall(
                        lifecycle.engine.unified_query,
                        task["query"], revision=persistent_revision,
                        transient_revision=lifecycle.engine.transient_revision,
                        searches=cython_searches, source_order=SOURCE_ORDER,
                        candidate_limit=args.candidate_limit, rank_options=RANK_OPTIONS,
                        query_vector=query_vector, vector_version=vector_version,
                    )
                    stats = pstats.Stats(profiler).strip_dirs().sort_stats("cumtime")
                    profile_summary = [
                        {"function": f"{filename}:{line}:{name}", "calls": calls,
                         "cumulative_ms": round(cumulative * 1000, 3)}
                        for (filename, line, name), (primitive, calls, total, cumulative, callers)
                        in list(stats.stats.items())
                    ]
                    profile_summary.sort(key=lambda row: row["cumulative_ms"], reverse=True)
                    profile_summary = profile_summary[:15]
                else:
                    warm_py = lifecycle.engine.unified_query(
                        task["query"], revision=persistent_revision,
                        transient_revision=lifecycle.engine.transient_revision,
                        searches=cython_searches, source_order=SOURCE_ORDER,
                        candidate_limit=args.candidate_limit, rank_options=RANK_OPTIONS,
                        query_vector=query_vector, vector_version=vector_version,
                    )
                ts_result = warm_ts.response
                py_result = warm_py
                ts_selected = ts_result.get("selected") or []
                py_selected = py_result.get("selected") or []
                if ts_selected and py_selected:
                    ts_idfs = {str(row.get("term") or ""): float(row.get("idf") or 0)
                               for row in ts_selected[0].get("query_idf_terms") or []}
                    py_idfs = {str(row.get("term") or ""): float(row.get("idf") or 0)
                               for row in py_selected[0].get("query_idf_terms") or []}
                    for term in ts_idfs.keys() | py_idfs.keys():
                        idf_term_comparisons += 1
                        idf_term_matches += int(term in ts_idfs and term in py_idfs
                                                and math.isclose(ts_idfs[term], py_idfs[term], rel_tol=0, abs_tol=1e-12))
                    for term, ts_idf in ts_idfs.items():
                        df = (lexical_stats["document_frequency"] or {}).get(term)
                        if df is not None:
                            ts_inferred_document_counts.append(
                                (math.exp(ts_idf) - 1) * (int(df) + 0.5) + int(df) - 0.5
                            )
                ts_clean = _clean_response(ts_result)
                py_clean = _clean_response(py_result)
                same = _same_value(py_clean, ts_clean)
                exact_matches += int(same)
                ts_ids = [row.get("id") for row in ts_result.get("selected", [])]
                py_ids = [row.get("id") for row in py_result.get("selected", [])]
                topk_matches += int(ts_ids == py_ids)
                ts_id_set = {str(value) for value in ts_ids}
                py_id_set = {str(value) for value in py_ids}
                union = ts_id_set | py_id_set
                jaccard = len(ts_id_set & py_id_set) / len(union) if union else 1.0
                topk_jaccard_total += jaccard
                source_jaccard = topk_jaccard_by_source.setdefault(task["source"], [0.0, 0.0])
                source_jaccard[0] += jaccard
                source_jaccard[1] += 1
                if not same:
                    mismatch_task_source_counts[task["source"]] += 1
                    failure_categories["response_mismatch"] = failure_categories.get("response_mismatch", 0) + 1
                    for field in _difference_paths(py_clean, ts_clean):
                        mismatch_fields[field] = mismatch_fields.get(field, 0) + 1
                ts_fusion = ts_result.get("fusion") or {}
                py_fusion = py_result.get("fusion") or {}
                fallback_matches += int(ts_fusion.get("fallback") == py_fusion.get("fallback"))
                # Unified rank results expose source identity in citation, not at row top-level.
                source_hits_ts += int(any(
                    (row.get("citation") or {}).get("source_type") == task["source"]
                    for row in ts_result.get("selected", [])
                ))
                source_hits_cython += int(any(
                    (row.get("citation") or {}).get("source_type") == task["source"]
                    for row in py_result.get("selected", [])
                ))
                target_selected_hits_ts[task["source"]] += int(any(
                    str(row.get("document_key") or "") == task["target_key"]
                    for row in ts_result.get("selected", [])
                ))
                target_selected_hits_cython[task["source"]] += int(any(
                    str(row.get("document_key") or "") == task["target_key"]
                    for row in py_result.get("selected", [])
                ))
                for ts_row, py_row in zip(ts_result.get("selected", []), py_result.get("selected", [])):
                    score_deltas.append(abs(float(ts_row.get("score") or 0) - float(py_row.get("score") or 0)))
                    rank_score_deltas.append(abs(float(ts_row.get("rank_score") or 0) - float(py_row.get("rank_score") or 0)))
                # Interleave timed order to reduce systematic warm-up/cache bias.
                for iteration in range(args.iterations):
                    if iteration % 2 == 0:
                        started = time.perf_counter()
                        await client._request(ts_payload)
                        ts_samples.append((time.perf_counter() - started) * 1000)
                        started = time.perf_counter()
                        lifecycle.engine.unified_query(
                            task["query"], revision=persistent_revision,
                            transient_revision=lifecycle.engine.transient_revision,
                            searches=cython_searches, source_order=SOURCE_ORDER,
                            candidate_limit=args.candidate_limit, rank_options=RANK_OPTIONS,
                            query_vector=query_vector, vector_version=vector_version,
                        )
                        cython_samples.append((time.perf_counter() - started) * 1000)
                    else:
                        started = time.perf_counter()
                        lifecycle.engine.unified_query(
                            task["query"], revision=persistent_revision,
                            transient_revision=lifecycle.engine.transient_revision,
                            searches=cython_searches, source_order=SOURCE_ORDER,
                            candidate_limit=args.candidate_limit, rank_options=RANK_OPTIONS,
                            query_vector=query_vector, vector_version=vector_version,
                        )
                        cython_samples.append((time.perf_counter() - started) * 1000)
                        started = time.perf_counter()
                        await client._request(ts_payload)
                        ts_samples.append((time.perf_counter() - started) * 1000)
            ts_worker_rss = _peak_rss_mib(client._process.pid) if client._process and client._process.pid else None
        except Exception as error:
            error.benchmark_stage = benchmark_stage
            raise
        finally:
            await _close_client(client)
            await dispose_engine()

        return {
            "status": "completed",
            "scope": "authorized owner corpus; owner-scoped persistent sources plus owner transient memory",
            "sources_tested": list(SOURCE_ORDER),
            "persistent_documents": len(persistent),
            "duplicate_persistent_slots": duplicate_slots,
            "duplicate_transient_slots": duplicate_transient_slots,
            "cross_corpus_memory_slot_collisions": cross_corpus_memory_slot_collisions,
            "transient_memory_documents": len(transient_documents),
            "persistent_cached_vectors": cached_persistent_vector_count,
            "transient_cached_vectors": cached_transient_vector_count,
            "effective_persistent_vectors": len(persistent_vectors),
            "effective_transient_vectors": len(transient_vectors),
            "synthetic_vector_replay": args.synthetic_vector_replay,
            "vector_mode": (
                "synthetic_document_and_query_vectors" if args.synthetic_vector_replay
                else "bm25_only" if args.bm25_only
                else "lexical_only" if args.conversation_user_queries
                else "cached_real_vectors" if persistent_vectors or transient_vectors
                else "no_cached_vectors_lexical_only"
            ),
            "query_task_mode": (
                "real_user_conversation_messages" if args.conversation_user_queries
                else "stratified_real_index_content" if args.stratified_content_queries
                else "real_index_titles"
            ),
            "query_task_source_counts": dict(source_task_counts),
            "vector_version_available": bool(storage_vector_version),
            "queries": len(tasks),
            "iterations_per_query_per_engine": args.iterations,
            "cython_extension_build_load_ms": round(cython_compile_ms, 2),
            "cython_index_load_ms": round(cython_index_load_ms, 2),
            "cython_full_rebuild_ms": round(cython_full_rebuild_ms, 2),
            "cython_cold_load_plus_snapshot_save_ms": round(
                cython_full_rebuild_ms + cython_snapshot_save_ms, 2,
            ),
            "cython_snapshot_save_ms": round(cython_snapshot_save_ms, 2),
            "cython_snapshot_bytes": cython_snapshot_bytes,
            "cython_snapshot_result": snapshot_result.get("snapshot_status"),
            "owner_revision_changed_during_setup": snapshot_revision_changed,
            "cython_index_load_phases_ms": {
                key: round(value, 2) for key, value in load_phases.items()
            },
            "memory_prepare_ms": round(memory_prepare_ms, 2),
            "cython_memory_warm_prepare_ms": {
                "p50": _percentile(cython_memory_warm_samples, .5),
                "p95": _percentile(cython_memory_warm_samples, .95),
            },
            "ts_memory_prepare_ms": round(ts_memory_prepare_ms, 2),
            "ts_memory_warm_prepare_ms": {
                "p50": _percentile(ts_memory_warm_samples, .5),
                "p95": _percentile(ts_memory_warm_samples, .95),
            },
            **({
                "cython_memory_prepare_phases_ms": {
                    key: round(value, 2) for key, value in memory_phase_timings.items()
                },
                "ts_memory_prepare_probe": {
                    "stage_ms": (ts_transient_response.get("probe") or {}).get("stage_ms", {}),
                    "counts": (ts_transient_response.get("probe") or {}).get("counts", {}),
                },
                "index_csr_assembly_estimate_ms": round(max(
                    0.0,
                    memory_phase_timings.get("index_csr_build_inclusive_ms", 0.0)
                    - memory_phase_timings.get("index_text_projection_ms", 0.0)
                    - memory_phase_timings.get("index_tokenization_ms", 0.0),
                ), 2),
                "transient_vector_state_install_estimate_ms": round(max(
                    0.0,
                    memory_phase_timings.get("transient_index_install_ms", 0.0)
                    - memory_phase_timings.get("index_token_stream_to_csr_ms", 0.0),
                ), 2),
            } if args.probe_memory_phases else {}),
            "ts_worker_startup_ms": round(ts_worker_start_ms, 2),
            "ts_index_load_ms": round(ts_load_ms, 2),
            "ts_cold_load_total_ms": round(ts_worker_start_ms + ts_load_ms, 2),
            "ts_worker_build_phases": ts_worker_build_phases,
            "ts_loaded_document_counts": {
                "persistent": int(ts_load_response.get("document_count") or 0),
                "transient": int(ts_transient_response.get("document_count") or 0),
            },
            "ts_loaded_vector_counts": {
                "persistent": int(ts_load_response.get("vector_count") or 0),
                "transient": int(ts_transient_response.get("vector_count") or 0),
            },
            "equivalent_load_checks": {
                "persistent_revision_equal": str(ts_load_response.get("revision") or "") == persistent_revision,
                "persistent_document_count_equal": int(ts_load_response.get("document_count") or 0) == len(persistent),
                "persistent_cached_vector_count_equal": int(ts_load_response.get("vector_count") or 0) == cached_persistent_vector_count,
                # 两个 runtime 的 transient revision 是各自的缓存令牌，不属于
                # 检索结果契约；内容相似度由下方候选/Top-K/IDF 指标衡量。
                "cython_transient_revision_present": bool(lifecycle.engine.transient_revision),
                "transient_document_count_equal": int(ts_transient_response.get("document_count") or 0) == len(transient_documents),
                "transient_cached_vector_count_equal": int(ts_transient_response.get("vector_count") or 0) == cached_transient_vector_count,
                "vector_counts_required_for_comparison": not args.synthetic_vector_replay,
            },
            "vector_query_replay_count": vector_query_count,
            "query_token_sequence_agreement": round(query_token_matches / len(tasks), 6),
            "lexical_candidate_order_agreement": round(lexical_order_matches / max(1, lexical_comparisons), 6),
            "memory_wire_shared_comparisons": memory_wire_shared,
            "memory_wire_mismatch_fields": dict(memory_wire_mismatches),
            "memory_wire_mismatches_by_source": dict(memory_wire_mismatches_by_source),
            "max_lexical_score_delta": round(max(lexical_score_deltas, default=0), 12),
            "lexical_by_source": {
                source: {
                    **values,
                    "max_score_delta": round(float(values["max_score_delta"]), 12),
                    "max_matched_key_score_delta": round(float(values["max_matched_key_score_delta"]), 12),
                }
                for source, values in lexical_by_source.items()
            },
            "query_embedding_provider_calls": query_embedding_provider_calls,
            "query_embedding_outcomes": dict(query_embedding_outcomes),
            "rank_idf_term_agreement": round(idf_term_matches / max(1, idf_term_comparisons), 6),
            "cython_rank_statistics": {
                "document_count": lexical_stats["document_count"],
                "average_length": round(float(lexical_stats["average_length"]), 6),
            },
            "ts_idf_implied_document_count_median": round(statistics.median(ts_inferred_document_counts), 3)
            if ts_inferred_document_counts else None,
            "exact_response_agreement": round(exact_matches / len(tasks), 6),
            "top_k_order_agreement": round(topk_matches / len(tasks), 6),
            "top_k_macro_jaccard": round(topk_jaccard_total / len(tasks), 6),
            "top_k_jaccard_by_source": {
                source: round(total / count, 6)
                for source, (total, count) in sorted(topk_jaccard_by_source.items())
            },
            "max_selected_score_delta": round(max(score_deltas, default=0), 12),
            "max_rank_score_delta": max(rank_score_deltas, default=0),
            "fallback_agreement": round(fallback_matches / len(tasks), 6),
            "relevant_source_hit_rate": {
                "ts": round(source_hits_ts / len(tasks), 6),
                "cython": round(source_hits_cython / len(tasks), 6),
            },
            "target_document_recall": {
                source: {
                    "queries": count,
                    "candidate_hit_rate_ts": round(target_candidate_hits_ts[source] / count, 6),
                    "candidate_hit_rate_cython": round(target_candidate_hits_cython[source] / count, 6),
                    "selected_hit_rate_ts": round(target_selected_hits_ts[source] / count, 6),
                    "selected_hit_rate_cython": round(target_selected_hits_cython[source] / count, 6),
                }
                for source, count in source_task_counts.items()
            },
            "ts_query_ms": {"p50": _percentile(ts_samples, .5), "p95": _percentile(ts_samples, .95)},
            "cython_query_ms": {"p50": _percentile(cython_samples, .5), "p95": _percentile(cython_samples, .95)},
            "ts_worker_peak_rss_mib": ts_worker_rss,
            "python_peak_rss_mib": _peak_rss_mib(os.getpid()),
            "python_startup_rss_mib": python_startup_rss,
            "python_baseline_rss_mib": python_baseline_rss,
            "python_rss_after_index_load_mib": python_index_rss,
            "python_index_incremental_rss_mib": round(max(
                0.0, (python_index_rss or 0) - (python_baseline_rss or 0),
            ), 2),
            "ts_architecture_combined_rss_estimate_mib": round(
                (python_baseline_rss or 0) + (ts_worker_rss or 0), 2,
            ),
            "cython_to_ts_architecture_peak_rss_ratio": round(
                (_peak_rss_mib(os.getpid()) or 0)
                / max(1.0, (python_baseline_rss or 0) + (ts_worker_rss or 0)), 4,
            ),
            "cython_to_ts_architecture_index_loaded_rss_ratio": round(
                (python_index_rss or 0)
                / max(1.0, (python_baseline_rss or 0) + (ts_worker_rss or 0)), 4,
            ),
            "mismatch_count": sum(failure_categories.values()),
            "mismatch_categories": failure_categories,
            "mismatch_fields": dict(sorted(mismatch_fields.items(), key=lambda item: (-item[1], item[0]))[:20]),
            "mismatch_task_source_counts": dict(mismatch_task_source_counts),
            "scope_note": (
                "查询文本来自真实索引；持久与 transient 文档向量、query vectors 均为确定性合成值，"
                "只用于验证 Hybrid/RRF 算法路径，不代表真实 embedding 语义；数据仅在进程内使用，"
                "不请求 embedding provider。"
                if args.synthetic_vector_replay else
                "查询文本来自真实 owner 数据；BM25-only 模式强制 query vector 为空，完整运行词法检索与 rank，"
                "不执行 Hybrid/RRF、不请求 embedding provider；索引加载仍按生产路径读取已有缓存向量。"
                if args.bm25_only else
                "查询文本来自真实 owner 数据；用户消息任务为 lexical-only。标题任务仅在索引确有缓存向量时"
                "回放真实向量；未请求 embedding provider，不验证在线 query embedding 延迟。"
            ),
            **({"profile_one_query": profile_summary} if args.profile_one_query and profile_summary else {}),
            **({"memory_prepare_profile": memory_prepare_profile}
               if args.profile_memory_prepare and memory_prepare_profile else {}),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="真实 owner RAG 上只读 TS/Cython full unified A/B")
    parser.add_argument("--owner-user-id", required=True, help="须是明确授权的单用户 UUID")
    parser.add_argument("--allow-real-data", action="store_true", help="确认读取该 owner 的真实索引与记忆")
    parser.add_argument("--queries", type=int, default=40)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--memory-prepare-repeats", type=int, default=3,
                        help="首次 Memory prepare 后的 warm 准备复测次数")
    parser.add_argument("--candidate-limit", type=int, default=24)
    parser.add_argument("--tokenizer-sample-only", action="store_true")
    parser.add_argument("--tokenizer-samples", type=int, default=256)
    parser.add_argument("--profile-one-query", action="store_true",
                        help="仅剖析首个真实 Cython 查询；结果不含查询文本")
    parser.add_argument("--profile-memory-prepare", action="store_true",
                        help="剖析 Cython Memory prepare 调用栈；结果不含用户数据")
    parser.add_argument("--probe-memory-phases", action="store_true",
                        help="只计时 Memory prepare 子阶段，不输出文档或查询正文")
    parser.add_argument("--synthetic-vector-replay", action="store_true",
                        help="只在进程内生成确定性向量，验证 Hybrid/RRF；不代表真实 embedding 效果")
    parser.add_argument("--bm25-only", action="store_true",
                        help="完整运行 lexical 检索与 rank，但强制 query vector 为空；不执行 Hybrid/RRF")
    parser.add_argument("--conversation-user-queries", action="store_true",
                        help="使用真实 owner 索引内的用户消息作为查询；只在进程内读取，不输出正文")
    parser.add_argument("--stratified-content-queries", action="store_true",
                        help="按 RAG 来源轮转采样，用真实索引标题与短正文构造查询；仅输出聚合命中率")
    parser.add_argument("--real-query-embedding", action="store_true",
                        help="最多 5 条真实查询各调用一次当前 embedding provider；不生成文档向量")
    args = parser.parse_args()
    if not args.allow_real_data:
        parser.error("真实语料读取需显式指定 --allow-real-data")
    if (args.queries < 1 or args.iterations < 1 or args.memory_prepare_repeats < 1
            or not 1 <= args.candidate_limit <= 50):
        parser.error("queries/iterations 必须为正数，candidate-limit 须在 1..50")
    if args.real_query_embedding and (args.queries > 5 or args.iterations != 1):
        parser.error("真实 provider 小样本要求 queries 不超过 5 且 iterations=1")
    if args.bm25_only and (args.synthetic_vector_replay or args.real_query_embedding):
        parser.error("BM25-only 不能与 synthetic vector replay 或真实 query embedding 同时使用")
    try:
        result = asyncio.run(_run_with_sidecar_cleanup(args))
    except Exception as error:
        frame = traceback.extract_tb(error.__traceback__)[-1]
        error_code = getattr(error, "code", None)
        safe_diagnostics = getattr(error, "diagnostics", {})
        print(
            f"A/B 失败：{type(error).__name__}；阶段={getattr(error, 'benchmark_stage', 'setup')}"
            f"；位置={Path(frame.filename).name}:{frame.lineno}"
            f"；错误码={error_code or '无'}；阶段诊断={json.dumps(safe_diagnostics, ensure_ascii=False, sort_keys=True)}"
            "；异常详情省略以保护用户数据",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
