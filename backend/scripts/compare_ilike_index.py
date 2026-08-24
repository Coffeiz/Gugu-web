"""对比现有 ILIKE 与持久化知识索引的聚合检索耗时。

脚本只输出耗时、命中数和索引来源，不输出用户正文。
"""
from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from uuid import UUID

from sqlalchemy import or_, select

from agent.rag.lexical import BM25
from agent.rag.persistent_store import load_index_documents
from app.db.session import get_db
from app.models import ConversationMessage, ConversationSession, File, MindNode, Project


COMMON_SOURCE_TYPES = {"project", "file", "note", "conversation"}


def _percentile(values: list[float], percentile: float) -> float:
    values = sorted(values)
    if not values:
        return 0.0
    index = min(len(values) - 1, int(round((len(values) - 1) * percentile)))
    return values[index]


def _overlap_ratio(reference: set[str], candidate: set[str]) -> float:
    """计算候选 Top-K 落在 ILIKE 命中集合中的比例。"""
    return len(reference & candidate) / len(candidate) if candidate else 1.0


async def _ilike_source_ids(db, user_id: UUID, query: str) -> set[str]:
    """返回 ILIKE 命中的脱敏来源/主键集合，不返回正文。"""
    pattern = f"%{query}%"
    result: set[str] = set()
    for source, statement in (
        ("project", select(Project.id).where(
            Project.user_id == user_id, Project.archived == False,
            or_(Project.name.ilike(pattern), Project.client.ilike(pattern)),
        )),
        ("file", select(File.id).where(
            File.user_id == user_id, File.deleted_at.is_(None),
            File.display_name.ilike(pattern),
        )),
        ("note", select(MindNode.id).where(
            MindNode.user_id == user_id, MindNode.deleted_at.is_(None),
            or_(MindNode.title.ilike(pattern), MindNode.content_plain.ilike(pattern)),
        )),
        ("conversation", select(ConversationMessage.id).join(
            ConversationMessage.session,
        ).where(
            ConversationSession.user_id == user_id,
            ConversationMessage.content.ilike(pattern),
        )),
    ):
        rows = (await db.execute(statement)).scalars().all()
        result.update(f"{source}:{row}" for row in rows)
    return result


async def _run(user_id: UUID, queries: tuple[str, ...], repeat: int) -> None:
    async for db in get_db():
        load_started = time.perf_counter()
        documents = await load_index_documents(
            db, user_id, source_types=COMMON_SOURCE_TYPES,
        )
        index_load_ms = (time.perf_counter() - load_started) * 1000
        build_started = time.perf_counter()
        index = BM25(documents)
        index_build_ms = (time.perf_counter() - build_started) * 1000
        rows = []
        for query in queries:
            ilike_times: list[float] = []
            search_times: list[float] = []
            ilike_ids = await _ilike_source_ids(db, user_id, query)
            results = index.search(query, limit=10)
            index_ids = {f"{item.document.source_type}:{item.document.source_id}" for item in results}
            for _ in range(max(1, repeat)):
                started = time.perf_counter()
                await _ilike_source_ids(db, user_id, query)
                ilike_times.append((time.perf_counter() - started) * 1000)
                started = time.perf_counter()
                index.search(query, limit=10)
                search_times.append((time.perf_counter() - started) * 1000)
            overlap = _overlap_ratio(ilike_ids, index_ids)
            rows.append({
                "query_len": len(query),
                "ilike_hits": len(ilike_ids),
                "bm25_hits": len(index_ids),
                "top10_overlap": round(overlap, 4),
                "ilike_median_ms": round(statistics.median(ilike_times), 2),
                "ilike_p95_ms": round(_percentile(ilike_times, 0.95), 2),
                "bm25_hot_median_ms": round(statistics.median(search_times), 2),
                "bm25_hot_p95_ms": round(_percentile(search_times, 0.95), 2),
            })
        print({
            "source_types": sorted(COMMON_SOURCE_TYPES),
            "repeat": repeat,
            "index_documents": len(documents),
            "index_load_ms": round(index_load_ms, 2),
            "index_build_ms": round(index_build_ms, 2),
            "queries": rows,
        })
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="对比 ILIKE 与持久化 BM25 索引")
    parser.add_argument("--user-id", required=True, type=UUID)
    parser.add_argument("--query", action="append", required=True)
    parser.add_argument("--repeat", type=int, default=10)
    args = parser.parse_args()
    asyncio.run(_run(args.user_id, tuple(args.query), args.repeat))


if __name__ == "__main__":
    main()
