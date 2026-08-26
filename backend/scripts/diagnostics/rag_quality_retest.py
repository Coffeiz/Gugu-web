#!/usr/bin/env python3
"""在当前数据库记忆索引上做只读 RAG 质量对照。

默认只输出候选指纹；显式传入 ``--full-report`` 才写出本地非脱敏 Markdown。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select

import app.db.session as db_session
from agent.memory import embedding
from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.hybrid import hybrid_results
from agent.rag.models import RecallCandidate, Scope
from agent.rag.scope import owner_scope, group_scope
from agent.rag.service import _load_cached_vectors
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.ts_sidecar import score_candidates_with_cache
from app.models import MemoryReflectionCursor, User


QUERIES = (
    ("gta", "GTA 6"),
    ("canvas", "画布 卡片"),
    ("project", "项目文件"),
    ("reminder", "提醒"),
    ("image", "图片搜索"),
    ("memory", "记忆"),
    ("game", "最近好玩的游戏"),
    ("search", "搜索工具"),
    ("schedule", "日历安排"),
    ("work", "当前工作计划"),
)


def fp(value: object, size: int = 12) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:size]


def cosine(left: list[float], right: list[float]) -> float:
    from agent.memory.embedding import cosine as _cosine

    return float(_cosine(left, right))


def safe_score(value: object) -> float:
    try:
        return round(float(value), 6)
    except (TypeError, ValueError):
        return 0.0


def public(
    item,
    score: float,
    *,
    mode: str,
    norm: float | None = None,
    full: bool = False,
) -> dict[str, Any]:
    document = item.document if hasattr(item, "document") else item
    value = {
        "mode": mode,
        "source": document.source_id,
        "source_fp": fp(document.source_id),
        "chunk_fp": fp(document.chunk_id),
        "content_fp": fp(document.content),
        "raw": safe_score(score),
    }
    if norm is not None:
        value["norm"] = safe_score(norm)
        value["keep_035"] = bool(norm >= 0.35)
    if full:
        value.update({
            "source_type": document.source_type,
            "source_id": document.source_id,
            "chunk_id": document.chunk_id,
            "title": document.title,
            "summary": document.summary,
            "content": document.content,
        })
    return value


def _normalize_candidates(candidates: list[RecallCandidate]) -> list[RecallCandidate]:
    if not candidates:
        return []
    scores = [candidate.raw_score for candidate in candidates]
    low, high = min(scores), max(scores)
    if high <= low:
        values = [max(0.0, score) / (1.0 + max(0.0, score)) for score in scores]
    else:
        values = [(score - low) / (high - low) for score in scores]
    from dataclasses import replace
    return [replace(candidate, normalized_score=value) for candidate, value in zip(candidates, values)]


async def quality_views(
    owner_id: str, query: str, results, *, top_k: int, full: bool = False,
) -> dict[str, Any]:
    """输出四种离线策略；confidence 直接复用 TS worker，避免 Python 分词漂移。"""
    raw = list(results[:max(top_k, 20)])
    candidates = [
        RecallCandidate.from_result(item, rank=index)
        for index, item in enumerate(raw, start=1)
    ]
    normalized = _normalize_candidates(candidates)
    normalized_kept = [item for item in normalized if item.normalized_score >= 0.35]
    from dataclasses import replace
    confidence_candidates = [replace(item, fused_score=item.normalized_score) for item in normalized]
    confidence_kept, confidence_stats = await score_candidates_with_cache(
        owner_id, query, confidence_candidates, limit=top_k,
    )
    return {
        "unfiltered": [public(item, item.score, mode="unfiltered", full=full) for item in raw[:top_k]],
        "raw_score": [public(item, item.score, mode="raw_score", full=full) for item in raw[:top_k]],
        "normalized_score": [
            public(item, item.raw_score, mode="normalized_score", norm=item.normalized_score, full=full)
            for item in normalized_kept[:top_k]
        ],
        "confidence": [
            public(item.document, item.confidence, mode="confidence", norm=item.confidence, full=full)
            for item in confidence_kept
        ],
        "confidence_stats": confidence_stats,
    }


async def lexical(user_id: str, documents, query: str, limit: int):
    return await search_documents_with_cache(user_id, documents, query, limit=limit)


async def one_scope(
    user_id: str,
    label: str,
    scope: Scope,
    queries: tuple[tuple[str, str], ...],
    top_k: int,
    *,
    full: bool = False,
):
    adapter = MemoryAdapter(user_id)
    documents = await adapter.build_documents(scope=scope)
    vectors = await _load_cached_vectors(user_id, documents)
    output = {
        "scope_label": label,
        "document_count": len(documents),
        "vector_count": len(vectors),
        "queries": [],
    }
    for query_label, query in queries:
        started = time.perf_counter()
        lexical_results = await lexical(user_id, documents, query, max(top_k, 20))
        lexical_ms = round((time.perf_counter() - started) * 1000, 2)
        vector_results = []
        vector_ms = None
        query_vector = None
        if embedding.is_enabled():
            started = time.perf_counter()
            query_vector = await embedding.embed(query)
            vector_ms = round((time.perf_counter() - started) * 1000, 2)
            if query_vector:
                scored = [
                    (cosine(query_vector, vectors[doc.chunk_id]), doc)
                    for doc in documents if doc.chunk_id in vectors
                ]
                scored.sort(key=lambda pair: (-pair[0], pair[1].chunk_id))
                vector_results = [public(doc, score, mode="vector", full=full) for score, doc in scored[:top_k]]
        hybrid = []
        hybrid_norm = []
        quality = {}
        if query_vector:
            mixed, fallback = hybrid_results(
                lexical_results, documents, query_vector, vectors, limit=max(top_k, 20)
            )
            peak = max((float(item.score) for item in mixed), default=0.0)
            hybrid = [public(item, item.score, mode="hybrid", full=full) for item in mixed[:top_k]]
            hybrid_norm = [
                public(item, item.score, mode="hybrid-normalized",
                       norm=(float(item.score) / peak if peak > 0 else 0.0), full=full)
                for item in mixed[:top_k]
            ]
            quality = await quality_views(user_id, query, mixed, top_k=top_k, full=full)
        else:
            quality = await quality_views(user_id, query, lexical_results, top_k=top_k, full=full)
        output["queries"].append({
            "label": query_label,
            "query_fp": fp(query),
            "lexical_ms": lexical_ms,
            "vector_ms": vector_ms,
            "bm25": [public(item, item.score, mode="bm25", full=full) for item in lexical_results[:top_k]],
            "vector": vector_results,
            "hybrid": hybrid,
            "hybrid_normalized": hybrid_norm,
            "quality_strategies": quality,
        })
    return output


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user", default="")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument(
        "--full-report",
        default="",
        help="写入非脱敏 Markdown 报告；仅建议使用 /tmp 路径，不会写入 Git",
    )
    args = parser.parse_args()
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        user_id = args.user
        if not user_id:
            user_id = str((await db.execute(select(User.id).order_by(User.created_at))).scalars().first())
        cursors = (await db.execute(
            select(MemoryReflectionCursor.platform, MemoryReflectionCursor.bot_id,
                   MemoryReflectionCursor.scope_id)
            .where(MemoryReflectionCursor.owner_user_id == user_id,
                   MemoryReflectionCursor.scope_type == "group")
            .order_by(MemoryReflectionCursor.updated_at.desc())
        )).all()
    scopes = [("owner", owner_scope(user_id))]
    seen = set()
    for platform, bot_id, group_id in cursors:
        key = (str(platform), str(bot_id), str(group_id))
        if key in seen:
            continue
        seen.add(key)
        scopes.append((f"group-{len(seen)}", group_scope(user_id, platform, bot_id, group_id)))
        if len(scopes) >= 4:
            break
    results = []
    for label, scope in scopes:
        results.append(await one_scope(
            user_id, label, scope, QUERIES, args.top_k, full=bool(args.full_report),
        ))
    payload = {
        "embedding_enabled": embedding.is_enabled(),
        "embedding_model": embedding.model_tag(),
        "query_count": len(QUERIES),
        "scope_count": len(results),
        "scopes": results,
    }
    if args.full_report:
        path = _write_full_report(args.full_report, payload)
        print(json.dumps({"report": str(path), "scope_count": len(results)}, ensure_ascii=False))
    else:
        print(json.dumps(payload, ensure_ascii=False))


def _md(value: object) -> str:
    return str(value or "").replace("|", "\\|").replace("\n", "<br>")


def _write_full_report(filename: str, payload: dict[str, Any]) -> str:
    """把显式请求的完整召回结果写成本地 Markdown，不进入日志或 Git。"""
    lines = [
        "# RAG 召回质量对照报告（非脱敏）",
        "",
        f"- embedding：`{payload['embedding_enabled']}`",
        f"- embedding 模型：`{payload['embedding_model']}`",
        f"- scope 数量：`{payload['scope_count']}`",
        f"- 查询数量：`{payload['query_count']}`",
        "",
        "> 本报告由 `--full-report` 显式生成，仅保存在指定本地路径，不写入 Git。",
    ]
    for scope in payload["scopes"]:
        lines.extend(["", f"## Scope：{_md(scope['scope_label'])}", "", f"文档数：{scope['document_count']}"])
        for query in scope["queries"]:
            lines.extend(["", f"### 查询：{_md(query['label'])}", f"实际文本：{_md(next((text for label, text in QUERIES if label == query['label']), ''))}"])
            for name in ("bm25", "vector", "hybrid", "quality_strategies"):
                items = query.get(name, [])
                if name == "quality_strategies":
                    strategy_items = [(key, value) for key, value in items.items() if isinstance(value, list)]
                else:
                    strategy_items = [(name, items)]
                for strategy, candidates in strategy_items:
                    if not candidates:
                        continue
                    lines.extend(["", f"#### {strategy}", "", "|排名|分数|来源|标题|摘要|正文|", "|---:|---:|---|---|---|---|"])
                    for rank, candidate in enumerate(candidates, 1):
                        lines.append("|{}|{}|{}:{}|{}|{}|{}|".format(
                            rank, candidate.get("raw", candidate.get("norm", "")),
                            _md(candidate.get("source_type")), _md(candidate.get("source_id")),
                            _md(candidate.get("title")), _md(candidate.get("summary")), _md(candidate.get("content")),
                        ))
    path = Path(filename).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


if __name__ == "__main__":
    asyncio.run(main())
