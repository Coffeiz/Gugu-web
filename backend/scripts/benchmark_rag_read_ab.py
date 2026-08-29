"""在真实业务数据上对比 Python 来源读取与常驻 TS RAG worker。

脚本只读业务数据，不修改持久化索引；TS worker 使用临时索引目录。
Python 负责当前真实的数据库/存储读取，TS 负责同一批 canonical 文档的
构建和索引，输出阶段耗时以便判断下一步优化边界。

用法（在 devserver backend 目录执行）：
    PYTHONPATH=. .venv/bin/python scripts/benchmark_rag_read_ab.py \
        --owner-user-id <UUID>
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.rag.index_builder import build_source_documents
from agent.rag.models import IndexDocument
from agent.rag.models import Scope
from agent.rag.adapters.knowledge import KnowledgeAdapter
from agent.rag.ts_sidecar import TsSidecarClient
from app.core.config import get_settings
from app.db.session import dispose_engine, get_db


DEFAULT_SOURCES = (
    "memory",
    "knowledge",
    "project",
    "file",
    "note",
    "canvas",
    "conversation",
    "calendar",
    "scheduled_task",
)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * percentile))
    return ordered[index]


def _stats(values: list[float]) -> dict[str, float]:
    return {
        "median_ms": round(statistics.median(values), 2) if values else 0.0,
        "mean_ms": round(statistics.mean(values), 2) if values else 0.0,
        "p95_ms": round(_percentile(values, 0.95), 2),
    }


def _scope_record(document: IndexDocument, owner_user_id: UUID) -> dict[str, str]:
    """把 IndexDocument 转成 TS 通用 adapter 可消费的最小 source record。"""
    scope = document.scope
    return {
        "owner_user_id": str(owner_user_id),
        "platform": scope.platform,
        "bot_id": scope.bot_id,
        "group_id": scope.group_id,
        "scope_type": scope.scope_type,
        # TS adapter 要求 scope_id 存在；owner 数据用 owner UUID 表示自身范围。
        "scope_id": scope.scope_id or str(owner_user_id),
    }


def _merge_chunks(documents: list[IndexDocument]) -> list[IndexDocument]:
    """把 Python 已分块结果还原为 benchmark 用的父文档，避免 TS 二次分块。"""
    grouped: dict[str, list[IndexDocument]] = {}
    for document in documents:
        parent = document.parent_document_id or document.document_id
        grouped.setdefault(parent, []).append(document)
    merged: list[IndexDocument] = []
    for chunks in grouped.values():
        ordered = sorted(chunks, key=lambda item: item.chunk_index)
        first = ordered[0]
        text = first.content
        for chunk in ordered[1:]:
            overlap = 0
            max_overlap = min(240, len(text), len(chunk.content))
            for size in range(max_overlap, 0, -1):
                if text.endswith(chunk.content[:size]):
                    overlap = size
                    break
            text += chunk.content[overlap:]
        merged.append(IndexDocument(
            document_id=first.parent_document_id or first.document_id,
            parent_document_id=first.parent_document_id or first.document_id,
            source_type=first.source_type,
            source_id=first.source_id,
            scope=first.scope,
            title=first.title,
            summary=first.summary,
            content=text,
            version=first.version,
            updated_at=first.updated_at,
            metadata=first.metadata,
        ))
    return merged


def _to_ts_batch(documents: list[IndexDocument], owner_user_id: UUID) -> dict[str, list[dict[str, Any]]]:
    """使用父文档级真实 canonical 记录构造 TS 输入，不输出正文到 benchmark 结果。"""
    records: list[dict[str, Any]] = []
    for document in _merge_chunks(documents):
        metadata = dict(document.metadata or {})
        records.append({
            "id": document.source_id,
            "source_type": document.source_type,
            "scope": _scope_record(document, owner_user_id),
            "title": document.title or "未命名来源",
            "summary": document.summary,
            "content": document.content,
            "document_version": document.version,
            "updated_at": document.updated_at,
            "metadata": metadata,
        })
    # Python 输入已经是 canonical 文本；使用 generic builder，避免 file/canvas/
    # conversation adapter 再追加一遍来源头部后造成非公平的二次分块。
    return {"memory": records}


async def _load_sources(
    owner_user_id: UUID,
    sources: tuple[str, ...],
) -> tuple[dict[str, list[IndexDocument]], float]:
    started = time.perf_counter()
    loaded: dict[str, list[IndexDocument]] = {}
    async for db in get_db():
        for source_type in sources:
            if source_type == "knowledge":
                loaded[source_type] = await KnowledgeAdapter(owner_user_id).build_documents(
                    scope=Scope(owner_user_id=str(owner_user_id), scope_type="owner"),
                )
            else:
                loaded[source_type] = await build_source_documents(db, owner_user_id, source_type)
        break
    return loaded, (time.perf_counter() - started) * 1000


async def _measure_ts(
    client: TsSidecarClient,
    loaded: dict[str, list[IndexDocument]],
    owner_user_id: UUID,
    revision_prefix: str,
) -> tuple[dict[str, list[float]], dict[str, dict[str, int]]]:
    times: dict[str, list[float]] = {source: [] for source in loaded}
    counts: dict[str, dict[str, int]] = {}
    for source_type, documents in loaded.items():
        batch = _to_ts_batch(documents, owner_user_id)
        started = time.perf_counter()
        result = await client.build_and_index(
            batch,
            f"{revision_prefix}:{source_type}:{uuid.uuid4().hex}",
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        times[source_type].append(elapsed_ms)
        counts[source_type] = {
            "python_chunks": len(documents),
            "python_parent_documents": len(_merge_chunks(documents)),
            "ts_chunks": int(result.get("document_count") or 0),
        }
    return times, counts


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    owner_user_id = UUID(args.owner_user_id)
    sources = tuple(args.sources.split(",")) if args.sources else DEFAULT_SOURCES
    repeat = max(1, args.iterations)
    warmup = max(0, args.warmup)
    settings = get_settings().search

    with tempfile.TemporaryDirectory(prefix="gugu-rag-ab-") as index_dir:
        client = TsSidecarClient(
            f"benchmark:{uuid.uuid4().hex}",
            command=settings.ts_sidecar_command,
            index_dir=str(Path(index_dir) / "index"),
        )
        python_total: list[float] = []
        ts_times: dict[str, list[float]] = {source: [] for source in sources}
        last_loaded: dict[str, list[IndexDocument]] = {}
        last_counts: dict[str, dict[str, int]] = {}
        try:
            for _ in range(warmup):
                loaded, _ = await _load_sources(owner_user_id, sources)
                await _measure_ts(client, loaded, owner_user_id, "warmup")

            for iteration in range(repeat):
                loaded, python_ms = await _load_sources(owner_user_id, sources)
                python_total.append(python_ms)
                last_loaded = loaded
                measured, counts = await _measure_ts(
                    client, loaded, owner_user_id, f"iteration-{iteration}",
                )
                for source_type, values in measured.items():
                    ts_times[source_type].extend(values)
                last_counts = counts
        finally:
            await client.close()
            await dispose_engine()

    source_rows = {}
    for source_type in sources:
        source_rows[source_type] = {
            "python_chunks": len(last_loaded.get(source_type, [])),
            "python_parent_documents": last_counts.get(source_type, {}).get("python_parent_documents", 0),
            "ts_chunks": last_counts.get(source_type, {}).get("ts_chunks", 0),
            "ts_build_and_index": _stats(ts_times[source_type]),
        }
    return {
        "owner": "provided",
        "sources": list(sources),
        "warmup": warmup,
        "iterations": repeat,
        "python_source_read": _stats(python_total),
        "sources_detail": source_rows,
        "interpretation": {
            "python_source_read": "真实数据库/存储读取与 Python canonical projection",
            "ts_build_and_index": "同一批真实文档经 JSONL IPC 后的常驻 TS 构建与索引",
            "not_measured": "TS 直连 PostgreSQL/对象存储；当前生产架构尚未由 TS 负责业务读取",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="真实数据上的 Python/TS RAG 读取链路 AB 测试")
    parser.add_argument("--owner-user-id", required=True, help="测试用户 UUID")
    parser.add_argument(
        "--sources",
        default=",".join(DEFAULT_SOURCES),
        help="逗号分隔来源，默认覆盖当前 RAG 业务来源",
    )
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--warmup", type=int, default=1)
    args = parser.parse_args()
    try:
        result = asyncio.run(_run(args))
    except ValueError as error:
        parser.error(f"参数或来源无效：{error}")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
