from pathlib import Path
import json
import statistics
import time

import pytest

from agent.rag.models import IndexDocument, Scope
from agent.rag.ts_sidecar import TsLexicalIndex, TsSidecarClient


@pytest.mark.asyncio
async def test_batch_preserves_source_scores_scope_and_independent_limits(tmp_path):
    """文件候选多于额度时仍保留其他来源，批量与逐来源分数完全一致。"""
    worker = Path(__file__).parents[1] / "ts/workers/rag/src/index.ts"
    client = TsSidecarClient("synthetic-owner", command=f"node --experimental-strip-types {worker}",
                             index_dir=str(tmp_path / "index"))
    scope = Scope("synthetic-owner")
    documents = [IndexDocument(f"{source}:{number}", source, str(number), scope,
                               "项目缓存", "", f"项目缓存验证 {number}", "v1")
                 for source in ("file", "knowledge", "conversation") for number in range(25)]
    try:
        await client.replace(documents, "r1")
        index = TsLexicalIndex(documents, client, "r1")
        specs = [{"source_types": {source}, "scope": scope, "limit": 5}
                 for source in ("file", "knowledge", "conversation")]
        expected = [await index.search("项目", source_types=item["source_types"], scope=scope, limit=5)
                    for item in specs]
        batches, counts, timing = await index.batch_search("项目", specs)
        for old, (new, _) in zip(expected, batches):
            assert [(item.document.chunk_id, item.score) for item in new] == [(item.document.chunk_id, item.score) for item in old]
            assert len(new) == 5
        assert counts == {"file": 25, "knowledge": 25, "conversation": 25}
        assert timing.queue_wait_ms >= 0
        empty, _, _ = await index.batch_search("", specs)
        assert all(not hits for hits, _ in empty)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_batch_warm_benchmark_preserves_all_source_candidates(tmp_path, monkeypatch):
    """固定合成语料对比词法层热路径，不把它冒充端到端性能。"""
    monkeypatch.setattr("agent.rag.ts_sidecar._timeout_seconds", lambda: 5.0)
    worker = Path(__file__).parents[1] / "ts/workers/rag/src/index.ts"
    client = TsSidecarClient("synthetic-benchmark", command=f"node --experimental-strip-types {worker}",
                             index_dir=str(tmp_path / "index"))
    sources = ("file", "knowledge", "project", "canvas", "note", "conversation")
    scope = Scope("synthetic-benchmark")
    documents = [IndexDocument(f"{source}:{number}", source, str(number), scope,
                               "项目缓存", "", f"项目缓存部署验证 内容编号 {number}", "v1")
                 for source in sources for number in range(300)]
    specs = [{"source_types": {source}, "scope": scope, "limit": 20} for source in sources]
    def signature(hits):
        return [(item.document.chunk_id, item.score) for item in hits]
    try:
        started = time.monotonic()
        await client.replace(documents, "r1")
        cold_ms = (time.monotonic() - started) * 1000
        index = TsLexicalIndex(documents, client, "r1")
        timings = {"legacy": [], "batch": []}
        for iteration in range(30):
            outputs = {}
            for mode in (("legacy", "batch") if iteration % 2 == 0 else ("batch", "legacy")):
                started = time.monotonic()
                if mode == "legacy":
                    outputs[mode] = [signature(await index.search("项目缓存", source_types=spec["source_types"], scope=scope, limit=20)) for spec in specs]
                else:
                    batches, _, _ = await index.batch_search("项目缓存", specs)
                    outputs[mode] = [signature(hits) for hits, _ in batches]
                timings[mode].append((time.monotonic() - started) * 1000)
            assert outputs["legacy"] == outputs["batch"]
        print(json.dumps({"benchmark": "lexical_only", "documents": len(documents), "samples": 30,
                          "cold_replace_ms": round(cold_ms, 2),
                          **{mode: {"p50_ms": round(statistics.median(values), 2),
                                    "p95_ms": round(sorted(values)[28], 2)}
                             for mode, values in timings.items()}}))
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_batch_mixed_corpus_keeps_memory_stats_independent(tmp_path):
    """Memory 瞬态语料与持久化语料同一次 IPC 返回，且各自保留 BM25 统计边界。"""
    worker = Path(__file__).parents[1] / "ts/workers/rag/src/index.ts"
    client = TsSidecarClient("mixed-corpus-owner", command=f"node --experimental-strip-types {worker}",
                             index_dir=str(tmp_path / "index"))
    scope = Scope("mixed-corpus-owner")
    # 持久化语料 100 篇 + Memory 语料 5 篇：若 BM25 用全局统计，Memory 分数必然偏离独立索引。
    persistent = [IndexDocument(f"file:{number}", "file", str(number), scope,
                                "项目缓存", "", f"项目缓存部署验证 内容编号 {number}", "v1")
                  for number in range(100)]
    memory = [IndexDocument("memory:daily-1", "memory", "daily", scope,
                            "记忆", "", "用户偏好项目缓存相关的记忆条目", "v1")]
    try:
        await client.replace(persistent, "r1")
        await client.replace_transient(memory, "mem-1")
        index = TsLexicalIndex(persistent, client, "r1")
        specs = [
            {"source_types": {"file"}, "scope": scope, "limit": 10},
            {"source_types": {"memory"}, "scope": None, "limit": 10, "corpus": "transient"},
        ]
        batches, counts, _timing = await index.batch_search(
            "项目缓存", specs,
            extra_documents={"memory:memory:daily-1:0": memory[0]})
        file_hits, memory_hits = (hits for hits, _ in batches)
        assert counts == {"file": 100, "memory": 1}
        # Memory 候选必须与"只装 Memory 语料的独立索引"分数完全一致（独立统计边界）。
        solo = TsSidecarClient("solo-memory-owner", command=f"node --experimental-strip-types {worker}",
                               index_dir=str(tmp_path / "solo"))
        try:
            await solo.replace(memory, "mem-1")
            solo_index = TsLexicalIndex(memory, solo, "mem-1")
            expected = await solo_index.search("项目缓存", source_types={"memory"}, limit=10)
            assert [(item.document.chunk_id, round(item.score, 9)) for item in memory_hits] == \
                [(item.document.chunk_id, round(item.score, 9)) for item in expected]
            assert memory_hits and memory_hits[0].document.source_id == "daily"
        finally:
            await solo.close()
        assert file_hits and file_hits[0].document.source_type == "file"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_batch_transient_revision_mismatch_is_rejected(tmp_path):
    """瞬态语料指纹不匹配时显式报错，不允许静默回退到旧语料。"""
    worker = Path(__file__).parents[1] / "ts/workers/rag/src/index.ts"
    client = TsSidecarClient("stale-transient", command=f"node --experimental-strip-types {worker}",
                             index_dir=str(tmp_path / "index"))
    scope = Scope("stale-transient")
    documents = [IndexDocument("file:1", "file", "1", scope, "文件", "", "缓存", "1")]
    try:
        await client.replace(documents, "r1")
        index = TsLexicalIndex(documents, client, "r1")
        specs = [{"source_types": {"memory"}, "scope": None, "limit": 5, "corpus": "transient"}]
        from agent.rag.ts_sidecar import TsSidecarUnavailable
        with pytest.raises(TsSidecarUnavailable):
            await index.batch_search("缓存", specs)
        # 装入瞬态语料后同一查询成功。
        await client.replace_transient(documents, "mem-1")
        batches, _counts, _timing = await index.batch_search("缓存", specs)
        assert not batches[0][0]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_transient_corpus_reuploads_after_worker_restart(tmp_path, monkeypatch):
    """worker 重启后进程代数变化，瞬态语料由 Python 重新上传，不依赖已失效进程。"""
    monkeypatch.setattr("agent.rag.ts_sidecar._timeout_seconds", lambda: 5.0)
    worker = Path(__file__).parents[1] / "ts/workers/rag/src/index.ts"
    client = TsSidecarClient("restart-owner", command=f"node --experimental-strip-types {worker}",
                             index_dir=str(tmp_path / "index"))
    scope = Scope("restart-owner")
    documents = [IndexDocument("file:1", "file", "1", scope, "文件", "", "缓存部署验证", "1")]
    memory = [IndexDocument("memory:daily-1", "memory", "daily", scope, "记忆", "", "缓存记忆", "v1")]
    try:
        await client.replace(documents, "r1")
        await client.replace_transient(memory, "mem-1")
        generation = client._process_generation
        await client.close()
        index = TsLexicalIndex(documents, client, "r1")
        specs = [{"source_types": {"memory"}, "scope": None, "limit": 5, "corpus": "transient"}]
        # 重启后瞬态槽为空：直接批量查询必须显式报错，而不是静默返回空结果。
        from agent.rag.ts_sidecar import TsSidecarUnavailable
        with pytest.raises(TsSidecarUnavailable):
            await index.batch_search("缓存", specs)
        assert client._process_generation != generation
        # 重新装入瞬态语料后恢复；持久化索引从磁盘恢复，词法结果保持一致。
        await client.replace_transient(memory, "mem-1")
        batches, counts, _timing = await index.batch_search(
            "缓存", specs, extra_documents={"memory:memory:daily-1:0": memory[0]})
        assert batches[0][0] and counts.get("memory") == 1
        persistent_hits = await index.search("缓存", source_types={"file"}, limit=5)
        assert persistent_hits
    finally:
        await client.close()
