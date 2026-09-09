#!/usr/bin/env python3
"""只读检查 RAG confidence 分数及其选择结果。

本脚本复用 ``rag_quality_retest.py`` 的真实召回链路，但把观察重点改为
``confidence``：同一批候选分别走当前 confidence 模式和不按 confidence
过滤的 top-k 观察模式；同时离线探测 ``K1=1.0 / B=0.5`` 的非线性
``rank_score``，输出每条候选的 fused/rank/confidence 分数、阈值区间、
当前是否被选中以及统计分布。

默认只输出来源和指纹。只有显式传入 ``--full-report`` 才会把标题、摘要和
正文写入指定的本地 Markdown；不要把该路径放入 Git。

示例（使用脚本内置查询）：
    cd backend
    PYTHONPATH=. .venv/bin/python scripts/diagnostics/rag_confidence_probe.py \
      --user <user-id> --top-k 10 --candidate-limit 20 \
      --full-report scripts/diagnostics/local/rag-confidence.md

示例（只测指定 query，可重复传入）：
    PYTHONPATH=. .venv/bin/python scripts/diagnostics/rag_confidence_probe.py \
      --user <user-id> --query "gpt6大概多少参数量" --query "蒙扎的T6叫什么"
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from sqlalchemy import select

import app.db.session as db_session
from agent.memory import embedding
from agent.rag.adapters.memory import MemoryAdapter
from agent.rag.hybrid import hybrid_results
from agent.rag.index_cache import search_documents_with_cache
from agent.rag.context import reset_conversation_before_message_id, set_conversation_before_message_id
from agent.rag.models import RecallCandidate, Scope, content_hash
from agent.rag.scope import group_scope, owner_scope
from agent.rag.service import _load_cached_vectors
from agent.rag.ts_sidecar import (
    close_lexical_clients,
    close_rank_clients,
    rank_candidates_with_cache,
)
from app.models import MemoryReflectionCursor, User

from scripts.diagnostics.rag_quality_retest import QUERIES, cosine, fp


# TS 线上当前 BM25 参数；诊断脚本在不改线上 worker 的前提下，用贡献项反推
# 文档长度比例，再离线重算另一组参数，保证报告确实对应待测参数。
ONLINE_BM25_K1 = 1.2
ONLINE_BM25_B = 0.75
PROBE_BM25_K1 = 1.0
PROBE_BM25_B = 0.5


def _run_message_text(message: dict[str, Any]) -> str:
    """提取可见对话文本，不把 RAG/system/tool 内部块混进对话原文。"""
    role = str(message.get("role") or "")
    if role not in {"user", "assistant"}:
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = str(block.get("text") or "").strip()
        if text and not text.startswith("[system-reminder]"):
            parts.append(text)
    return "\n".join(parts).strip()


def _parse_run_recall(text: str, *, full: bool) -> list[dict[str, Any]]:
    """解析 LoopScope 中已经注入模型的 owner-rag 结果。"""
    if not text:
        return []
    matches = list(re.finditer(r"\[(\d+)\]\s+([^/\n]+?)\s+/\s+([^\n]+)\n", text))
    rows: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else text.find("[/owner-rag]", start)
        if end < 0:
            end = len(text)
        content = text[start:end].strip()
        row = {
            "original_rank": int(match.group(1)),
            "source_type": match.group(2).strip(),
            "title": match.group(3).strip(),
            "content_fp": fp(content),
        }
        if full:
            row["content"] = content
        rows.append(row)
    return rows


def load_run_cases(filename: str, *, full: bool) -> list[dict[str, Any]]:
    """读取 LoopScope 导出，保留每轮对话和每个 RAG 注入块。"""
    payload = json.loads(Path(filename).expanduser().read_text(encoding="utf-8"))
    cases: list[dict[str, Any]] = []
    for run in payload.get("runs", []):
        if not isinstance(run, dict):
            continue
        run_input = run.get("input") or {}
        run_user_id = str(run_input.get("user_id") or "")
        application_boundary = (
            ((run.get("attributes") or {}).get("context_layout") or {})
            .get("application_boundary") or {}
        )
        run_session_id = application_boundary.get("session_id")
        run_replay_exclude_hashes: set[str] = set()
        for run_round in run.get("rounds", []):
            if not isinstance(run_round, dict):
                continue
            run_messages = ((run_round.get("input") or {}).get("messages") or [])
            for run_message in run_messages:
                if not isinstance(run_message, dict):
                    continue
                run_visible = _run_message_text(run_message)
                if run_visible:
                    run_replay_exclude_hashes.add(content_hash(run_visible))
        run_user_message = str(run_input.get("user_message") or "").strip()
        if run_user_message:
            run_replay_exclude_hashes.add(content_hash(run_user_message))
        rag_diagnostics = []
        for span in run.get("spans", []):
            if not isinstance(span, dict) or span.get("kind") != "rag":
                continue
            output = span.get("output") or {}
            quality = output.get("quality") if isinstance(output, dict) else None
            rag_diagnostics.append({
                "name": span.get("name"),
                "status": span.get("status"),
                "candidate_count": output.get("candidate_count") if isinstance(output, dict) else None,
                "hit_count": output.get("hit_count") if isinstance(output, dict) else None,
                "quality": quality,
                "engine": output.get("engine") if isinstance(output, dict) else None,
                "fallback_reason": output.get("fallback_reason") if isinstance(output, dict) else None,
            })
        for round_item in run.get("rounds", []):
            if not isinstance(round_item, dict):
                continue
            messages = ((round_item.get("input") or {}).get("messages") or [])
            transcript: list[dict[str, Any]] = []
            current_query = ""
            for message in messages:
                if not isinstance(message, dict):
                    continue
                visible = _run_message_text(message)
                if visible:
                    current_query = visible if message.get("role") == "user" else current_query
                    transcript_row = {"role": message.get("role"), "text_fp": fp(visible), "text_len": len(visible)}
                    if full:
                        transcript_row["text"] = visible
                    transcript.append(transcript_row)
                content = message.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "knowledge-context":
                        continue
                    rag_text = str(block.get("text") or "")
                    query_match = re.search(r"检索问题：([^\n]+)", rag_text)
                    query = (query_match.group(1).strip() if query_match else current_query).strip()
                    cases.append({
                        "run_id": run.get("id"),
                        "trace_id": run.get("trace_id"),
                        "session_id": run_session_id,
                        "round": round_item.get("attributes", {}).get("round", round_item.get("round")),
                        "user_id": run_user_id,
                        "query": query,
                        "query_fp": fp(query),
                        "transcript": transcript.copy(),
                        # 回放时排除本次 run 已经写入索引的对话正文；否则当前问题
                        # 会因为命中自己的历史消息而稳定占据第一名。
                        "replay_exclude_content_hashes": sorted(run_replay_exclude_hashes),
                        "original_recall": _parse_run_recall(rag_text, full=full),
                        "run_rag_diagnostics": rag_diagnostics,
                    })
    return cases


def confidence_band(value: object) -> str:
    """将 confidence 映射到生产选择器使用的三个可解释区间。"""
    try:
        score = float(value)
    except (TypeError, ValueError):
        score = 0.0
    if score >= 0.55:
        return "preferred"
    if score >= 0.35:
        return "fallback"
    return "rejected_low_score"


def confidence_distribution(values: list[float]) -> dict[str, Any]:
    """计算 confidence 分布；空集合也返回稳定字段，方便脚本对比。"""
    if not values:
        return {
            "count": 0,
            "min": 0.0,
            "max": 0.0,
            "mean": 0.0,
            "preferred_ge_055": 0,
            "fallback_035_to_055": 0,
            "low_lt_035": 0,
        }
    ordered = sorted(values)
    return {
        "count": len(values),
        "min": round(ordered[0], 6),
        "max": round(ordered[-1], 6),
        "mean": round(sum(values) / len(values), 6),
        "preferred_ge_055": sum(value >= 0.55 for value in values),
        "fallback_035_to_055": sum(0.35 <= value < 0.55 for value in values),
        "low_lt_035": sum(value < 0.35 for value in values),
    }


def _score(value: object) -> float:
    try:
        return round(float(value), 6)
    except (TypeError, ValueError):
        return 0.0


def idf_coverage(item: dict[str, Any]) -> float:
    """按 query token 的 IDF² 权重计算候选覆盖率，结果限定到 0~1。"""
    query_terms = item.get("query_idf_terms") or []
    if not isinstance(query_terms, list):
        return 0.0
    total = 0.0
    for term in query_terms:
        if not isinstance(term, dict):
            continue
        value = _score(term.get("idf"))
        total += value * value
    if total <= 0:
        return 0.0
    matched = {
        str(contribution.get("term") or "")
        for contribution in (item.get("rank_contributions") or [])
        if isinstance(contribution, dict)
    }
    weighted = sum(
        (_score(term.get("idf")) ** 2)
        for term in query_terms
        if isinstance(term, dict) and str(term.get("term") or "") in matched
    )
    return round(min(1.0, max(0.0, weighted / total)), 6)


def confidence_v2(item: dict[str, Any]) -> tuple[float, float]:
    """离线比较版 confidence-v2，不改变线上 confidence-v1。"""
    fused = _score(item.get("fused_score"))
    match = _score(item.get("query_match"))
    source_quality = _score(item.get("source_quality"))
    coverage = idf_coverage(item)
    value = 0.45 * fused + 0.20 * match + 0.15 * source_quality + 0.20 * coverage
    return round(min(1.0, max(0.0, value)), 6), coverage


def confidence_v4(
    item: dict[str, Any],
    *,
    lexical_norm: float,
    semantic_norm: float = 0.0,
) -> tuple[float, float]:
    """用非线性 IDF 词法分作为 conf 主信号的离线比较版。

    当前 run 重跑固定使用 ``strategy=bm25``，因此没有 embedding 分支时直接
    使用 lexical_norm；若后续诊断链提供 semantic_norm，则按 0.45/0.55
    融合。原始 rank_score 不直接进入 conf，先归一化到 0~1。
    """
    lexical = min(1.0, max(0.0, float(lexical_norm)))
    semantic = min(1.0, max(0.0, float(semantic_norm)))
    fused = lexical if semantic <= 0 else 0.45 * lexical + 0.55 * semantic
    match = _score(item.get("query_match"))
    source_quality = _score(item.get("source_quality_v4", item.get("source_quality")))
    value = 0.40 * fused + 0.20 * match + 0.40 * source_quality
    return round(min(1.0, max(0.0, value)), 6), round(fused, 6)


def rescore_rank_score(
    item: dict[str, Any],
    *,
    k1: float = PROBE_BM25_K1,
    b: float = PROBE_BM25_B,
) -> float:
    """按另一组 BM25 参数重算 TS 的非线性词法 rank 分。

    TS 返回的每个贡献项已经包含线上参数下的 ``weighted``、``idf``、``tf``
    和 ``queryWeight``。由线上 norm 反推出 ``document_length / average_length``
    后，可以在脚本中重算 K1/B，而不必启动第二个 worker 或修改生产协议。
    这只适用于当前 TS rank 贡献格式；缺少贡献项的候选按 0 分处理。
    """
    total = 0.0
    for contribution in item.get("rank_contributions") or []:
        if not isinstance(contribution, dict):
            continue
        term_frequency = float(
            contribution.get("term_frequency", contribution.get("termFrequency")) or 0.0
        )
        idf = float(contribution.get("idf") or 0.0)
        query_weight = float(
            contribution.get("query_weight", contribution.get("queryWeight")) or 0.0
        )
        weighted = float(contribution.get("weighted") or 0.0)
        if term_frequency <= 0 or idf <= 0 or query_weight <= 0 or weighted <= 0:
            continue

        # weighted = idf * tf * (ONLINE_K1 + 1) * queryWeight / online_norm
        online_norm = (
            idf * term_frequency * (ONLINE_BM25_K1 + 1.0) * query_weight / weighted
        )
        length_ratio = (
            ((online_norm - term_frequency) / ONLINE_BM25_K1)
            - (1.0 - ONLINE_BM25_B)
        ) / ONLINE_BM25_B
        length_ratio = max(0.0, length_ratio)

        norm = term_frequency + k1 * (1.0 - b + b * length_ratio)
        if norm <= 0:
            continue
        probe_weighted = idf * term_frequency * (k1 + 1.0) * query_weight / norm
        total += probe_weighted ** 2
    return round(total, 6)


def source_quality_v4(item: dict[str, Any]) -> float:
    """v4 离线质量先验；未显式配置的来源与 conversation 一律按 0.5。"""
    source_quality = {
        "project": 0.8,
        "memory": 0.9,
        "knowledge": 1.0,
        "file": 0.8,
        "canvas": 0.5,
        "calendar": 0.5,
        "journal": 0.8,
        "conversation": 0.5,
    }
    return source_quality.get(str(item.get("source_type") or ""), 0.5)


def apply_confidence_v4(rows: list[dict[str, Any]], *, semantic_scores: dict[str, float] | None = None) -> None:
    """为同一候选池计算 v4 的 lexical/fused/conf，原地补充诊断字段。"""
    for row in rows:
        row["rank_score_probe"] = rescore_rank_score(row)
    maximum = max((_score(row.get("rank_score_probe")) for row in rows), default=0.0)
    for row in rows:
        rank_score = _score(row.get("rank_score_probe"))
        lexical_norm = rank_score / maximum if maximum > 0 else 0.0
        key = f"{row.get('source_type', '')}:{row.get('chunk_fp', '')}"
        semantic_norm = _score((semantic_scores or {}).get(key))
        row["source_quality_v4"] = source_quality_v4(row)
        value, fused = confidence_v4(
            row,
            lexical_norm=lexical_norm,
            semantic_norm=semantic_norm,
        )
        row["lexical_norm_v4"] = round(min(1.0, max(0.0, lexical_norm)), 6)
        row["semantic_norm_v4"] = semantic_norm
        row["fused_v4"] = fused
        row["confidence_v4"] = value
        row["confidence_v4_delta"] = round(value - _score(row.get("confidence")), 6)
        row["confidence_v4_band"] = confidence_band(value)


def sort_by_confidence_v4(rows: list[dict[str, Any]]) -> None:
    """按 v4 confidence 排观察榜单；后两项保证同分时结果稳定。"""
    rows.sort(
        key=lambda row: (
            -_score(row.get("confidence_v4")),
            -_score(row.get("rank_score_probe")),
            int(row.get("original_rank") or 0),
        )
    )


def _candidate_key(item: dict[str, Any]) -> tuple[str, str]:
    citation = item.get("citation") or {}
    return str(citation.get("source_type") or ""), str(citation.get("chunk_id") or "")


def _full_unified_retriever(user_id: str):
    """构造与自动 RAG 相同的全来源 TS 查询器。"""
    from agent.rag.adapters.indexed_sources import IndexedSourceRetriever
    from agent.rag.batch_retriever import UnifiedQueryRetriever
    from agent.rag.service import MemoryRetriever, ProjectRetriever
    from app.core.config import get_settings

    db_session.ensure_engine()
    db_factory = db_session._SessionLocal
    retrievers = [
        MemoryRetriever(user_id),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="knowledge"),
        ProjectRetriever(user_id, db_factory=db_factory),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="file"),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="canvas"),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="note"),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="calendar"),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="scheduled_task"),
        IndexedSourceRetriever(user_id, db_factory=db_factory, source_type="conversation"),
    ]
    enabled = set(get_settings().search.rag_auto_sources)
    retrievers = [item for item in retrievers if item.source_type in enabled]
    return UnifiedQueryRetriever(retrievers, session_factory=db_factory)


async def _unified_rank_views(
    owner_id: str,
    query: str,
    *,
    top_k: int,
    candidate_limit: int,
    full: bool,
    exclude_content_hashes: set[str] | None = None,
) -> dict[str, Any]:
    """用完整 unified RAG 候选池输出 v1/v2 与未过滤 rank top-k。"""
    retriever = _full_unified_retriever(owner_id)
    scope = owner_scope(owner_id)
    common = {
        "source": "all",
        "scope": scope,
        "strategy": "bm25",
        "candidate_limit": candidate_limit,
    }
    confidence_batch = (await retriever.retrieve(
        query, **common,
        rank_options={
            "limit": top_k,
            "max_chars": 3000,
            "max_per_source": 3,
            "max_per_parent": 3,
            "selection_mode": "confidence",
            "exclude_content_hashes": sorted(exclude_content_hashes or set()),
        },
    ))[0]
    observed_batch = (await retriever.retrieve(
        query, **common,
        rank_options={
            "limit": candidate_limit,
            # 观察模式要拿到未过滤 top-k，不能让第一条长正文耗尽生产预算。
            "max_chars": max(100_000, top_k * 10_000),
            "max_per_source": candidate_limit,
            "max_per_parent": candidate_limit,
            "selection_mode": "top_k",
            "exclude_content_hashes": sorted(exclude_content_hashes or set()),
        },
    ))[0]
    observed = list(observed_batch.rank_rows)
    selected_keys = {
        (candidate.document.source_type, candidate.document.chunk_id)
        for candidate, _text, _item in confidence_batch.rank_rows
    }
    rows: list[dict[str, Any]] = []
    for candidate, _text, item in observed:
        key = (candidate.document.source_type, candidate.document.chunk_id)
        rows.append(_public_candidate(
            candidate,
            item,
            original_rank=candidate.rank,
            current_selected=key in selected_keys,
            full=full,
        ))
    apply_confidence_v4(rows)
    sort_by_confidence_v4(rows)
    v4_preferred = [row for row in rows if row["confidence_v4"] >= 0.55]
    v4_fallback = [row for row in rows if 0.35 <= row["confidence_v4"] < 0.55]
    for row in (v4_preferred or v4_fallback)[:top_k]:
        row["confidence_v4_selection"] = True
    for row in rows:
        row.setdefault("confidence_v4_selection", False)
    values = [_score(row["confidence"]) for row in rows]
    return {
        "candidate_count": observed_batch.candidate_count,
        "confidence_selected": [
            _public_candidate(
                candidate,
                item,
                original_rank=candidate.rank,
                current_selected=True,
                full=full,
            )
            for candidate, _text, item in confidence_batch.rank_rows
        ],
        "confidence_v4_selected": [row for row in rows if row["confidence_v4_selection"]],
        "top_k_observation": rows[:top_k],
        "confidence_stats": confidence_batch.rank_stats or {},
        "top_k_stats": observed_batch.rank_stats or {},
        "distribution": confidence_distribution(values),
    }


def _public_candidate(
    candidate: RecallCandidate,
    item: dict[str, Any],
    *,
    original_rank: int,
    current_selected: bool,
    full: bool,
) -> dict[str, Any]:
    confidence = _score(item.get("confidence"))
    document = candidate.document
    value: dict[str, Any] = {
        "original_rank": original_rank,
        "source_type": document.source_type,
        "source_fp": fp(document.source_id),
        "chunk_fp": fp(document.chunk_id),
        "content_fp": fp(document.content),
        "raw_score": _score(candidate.raw_score),
        "normalized_score": _score(item.get("normalized_score")),
        "fused_score": _score(item.get("fused_score")),
        "rank_score": _score(item.get("rank_score")),
        "confidence": confidence,
        "source_quality": _score(item.get("source_quality")),
        "confidence_band": confidence_band(confidence),
        "current_confidence_selection": current_selected,
        "query_idf_baseline": item.get("query_idf_baseline"),
        "rank_contributions": item.get("rank_contributions") or [],
    }
    value["query_match"] = _score(item.get("query_match"))
    value["query_idf_terms"] = item.get("query_idf_terms") or []
    confidence_v2_value, coverage = confidence_v2(item)
    value["idf_coverage"] = coverage
    value["confidence_v2"] = confidence_v2_value
    value["confidence_v2_delta"] = round(confidence_v2_value - confidence, 6)
    value["confidence_v2_band"] = confidence_band(confidence_v2_value)
    if full:
        value.update({
            "source_id": document.source_id,
            "chunk_id": document.chunk_id,
            "title": document.title,
            "summary": document.summary,
            "content": document.content,
        })
    return value


async def _rank_views(
    owner_id: str,
    query: str,
    raw_results,
    *,
    corpus_documents,
    top_k: int,
    candidate_limit: int,
    full: bool,
) -> dict[str, Any]:
    candidates = [
        RecallCandidate.from_result(item, rank=index)
        for index, item in enumerate(raw_results[:candidate_limit], start=1)
    ]
    if not candidates:
        return {
            "candidate_count": 0,
            "confidence_selected": [],
            "top_k_observation": [],
            "confidence_stats": {},
            "top_k_stats": {},
            "distribution": confidence_distribution([]),
        }

    confidence_selected, confidence_stats = await rank_candidates_with_cache(
        owner_id,
        query,
        candidates,
        limit=top_k,
        max_chars=3000,
        max_per_source=3,
        max_per_parent=3,
        selection_mode="confidence",
        corpus_documents=corpus_documents,
    )
    # 观察模式放宽来源/父文档上限，尽量拿到同一候选池的完整 confidence
    # 分布；它只用于诊断，不代表生产选择结果。
    observed, top_k_stats = await rank_candidates_with_cache(
        owner_id,
        query,
        candidates,
        limit=len(candidates),
        max_chars=3000,
        max_per_source=len(candidates),
        max_per_parent=len(candidates),
        selection_mode="top_k",
        corpus_documents=corpus_documents,
    )
    selected_keys = {_candidate_key(item) for _, _, item in confidence_selected}
    candidate_by_key = {
        (candidate.document.source_type, candidate.document.chunk_id): candidate
        for candidate in candidates
    }
    original_ranks = {
        (candidate.document.source_type, candidate.document.chunk_id): candidate.rank
        for candidate in candidates
    }

    rows: list[dict[str, Any]] = []
    for candidate, _, item in observed:
        key = _candidate_key(item)
        source_candidate = candidate_by_key.get(key, candidate)
        rows.append(_public_candidate(
            source_candidate,
            item,
            original_rank=original_ranks.get(key, source_candidate.rank),
            current_selected=key in selected_keys,
            full=full,
        ))
    apply_confidence_v4(rows)
    sort_by_confidence_v4(rows)
    v4_preferred = [row for row in rows if row["confidence_v4"] >= 0.55]
    v4_fallback = [row for row in rows if 0.35 <= row["confidence_v4"] < 0.55]
    for row in (v4_preferred or v4_fallback)[:top_k]:
        row["confidence_v4_selection"] = True
    for row in rows:
        row.setdefault("confidence_v4_selection", False)
    values = [_score(row["confidence"]) for row in rows]
    return {
        "candidate_count": len(candidates),
        "confidence_selected": [
            _public_candidate(
                candidate,
                item,
                original_rank=original_ranks.get(_candidate_key(item), candidate.rank),
                current_selected=True,
                full=full,
            )
            for candidate, _, item in confidence_selected
        ],
        "confidence_v4_selected": [
            row for row in rows if row["confidence_v4_selection"]
        ],
        # 观察榜单不走任何 confidence 过滤，只展示 rank_score 排序后的 top-k。
        "top_k_observation": rows[:top_k],
        "confidence_stats": confidence_stats,
        "top_k_stats": top_k_stats,
        "distribution": confidence_distribution(values),
    }


async def _query_scope(
    user_id: str,
    scope: Scope,
    queries: tuple[tuple[str, str], ...],
    *,
    top_k: int,
    candidate_limit: int,
    full: bool,
    exclude_content_hashes: set[str] | None = None,
) -> dict[str, Any]:
    output: dict[str, Any] = {
        "scope_type": scope.scope_type,
        "scope_id_fp": fp(scope.scope_id),
        "document_count": 0,
        "vector_count": 0,
        "queries": [],
    }
    for query_label, query in queries:
        started = time.perf_counter()
        views = await _unified_rank_views(
            user_id, query, top_k=top_k, candidate_limit=candidate_limit, full=full,
            exclude_content_hashes=exclude_content_hashes,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        output["queries"].append({
            "label": query_label,
            "query_fp": fp(query),
            "lexical_ms": elapsed_ms,
            "embedding_used": False,
            "confidence_views": views,
        })
    return output


async def _resolve_run_query_message_ids(
    user_id: str,
    session_id: object,
    queries: list[str],
) -> list[int | None]:
    """按 run 输入顺序定位每条 query 的会话消息 ID，恢复历史水位。"""
    if not session_id or not queries:
        return [None for _ in queries]
    from app.models import ConversationMessage

    async with db_session._SessionLocal() as db:
        messages = (await db.execute(
            select(ConversationMessage.id, ConversationMessage.content)
            .where(
                ConversationMessage.session_id == int(session_id),
                ConversationMessage.role == "user",
            )
            .order_by(ConversationMessage.id.asc())
        )).all()
    resolved: list[int | None] = []
    cursor = 0
    for query in queries:
        normalized = str(query or "").strip()
        match_index = next(
            (
                index for index in range(cursor, len(messages))
                if str(messages[index][1] or "").strip() == normalized
            ),
            None,
        )
        if match_index is None:
            resolved.append(None)
            continue
        resolved.append(int(messages[match_index][0]))
        cursor = match_index + 1
    return resolved


async def _load_scopes(user_id: str) -> list[tuple[str, Scope]]:
    async with db_session._SessionLocal() as db:
        cursors = (await db.execute(
            select(
                MemoryReflectionCursor.platform,
                MemoryReflectionCursor.bot_id,
                MemoryReflectionCursor.scope_id,
            )
            .where(
                MemoryReflectionCursor.owner_user_id == user_id,
                MemoryReflectionCursor.scope_type == "group",
            )
            .order_by(MemoryReflectionCursor.updated_at.desc())
        )).all()
    scopes = [("owner", owner_scope(user_id))]
    seen: set[tuple[str, str, str]] = set()
    for platform, bot_id, group_id in cursors:
        key = (str(platform), str(bot_id), str(group_id))
        if key in seen:
            continue
        seen.add(key)
        scopes.append((f"group-{len(seen)}", group_scope(user_id, platform, bot_id, group_id)))
        if len(scopes) >= 4:
            break
    return scopes


async def _probe_run(
    filename: str,
    *,
    override_user_id: str,
    top_k: int,
    candidate_limit: int,
    full: bool,
) -> dict[str, Any]:
    """以 LoopScope run 为主输入，重跑每个原始 RAG query 的当前 conf。"""
    cases = load_run_cases(filename, full=full)
    boundary_by_case: dict[int, int | None] = {}
    grouped_cases: dict[tuple[str, str, str], list[int]] = {}
    for index, case in enumerate(cases):
        key = (
            str(case.get("run_id") or ""),
            str(case.get("user_id") or ""),
            str(case.get("session_id") or ""),
        )
        grouped_cases.setdefault(key, []).append(index)
    for (_run_id, user_id, session_id), indexes in grouped_cases.items():
        message_ids = await _resolve_run_query_message_ids(
            user_id,
            session_id,
            [str(cases[index].get("query") or "") for index in indexes],
        )
        for index, message_id in zip(indexes, message_ids, strict=True):
            boundary_by_case[index] = message_id

    output_cases = []
    for case_index, case in enumerate(cases):
        user_id = override_user_id or str(case.get("user_id") or "")
        if not user_id:
            raise ValueError(f"run 缺少 user_id，无法定位 RAG corpus：{case.get('run_id')}")
        before_message_id = boundary_by_case.get(case_index)
        boundary_token = set_conversation_before_message_id(before_message_id)
        try:
            current = await _query_scope(
                user_id,
                owner_scope(user_id),
                (("run-query", str(case["query"])),),
                top_k=top_k,
                candidate_limit=candidate_limit,
                full=full,
                # 能恢复历史水位时优先使用它；只有 run 没带 session/message
                # 对齐信息时，才用正文 hash 作为回放污染的保守兜底。
                exclude_content_hashes=(
                    set() if before_message_id is not None
                    else set(case.get("replay_exclude_content_hashes") or ())
                ),
            )
        finally:
            reset_conversation_before_message_id(boundary_token)
        current_query = current["queries"][0] if current["queries"] else {}
        output_cases.append({
            "run_id": case["run_id"],
            "trace_id": case["trace_id"],
            "round": case["round"],
            "user_fp": fp(user_id),
            "query": case["query"] if full else None,
            "query_fp": case["query_fp"],
            "transcript": case["transcript"],
            "original_recall": case["original_recall"],
            "replay_exclude_count": (
                0 if before_message_id is not None
                else len(case.get("replay_exclude_content_hashes") or ())
            ),
            "replay_before_message_id": before_message_id,
            "run_rag_diagnostics": case["run_rag_diagnostics"],
            "current_confidence_recheck": current_query,
        })
    return {
        "input_run": str(Path(filename).expanduser().resolve()),
        "case_count": len(output_cases),
        "cases": output_cases,
    }


def _markdown(payload: dict[str, Any]) -> str:
    def md(value: object) -> str:
        return str(value or "").replace("|", "\\|").replace("\n", "<br>")

    lines = [
        "# RAG confidence 分数诊断报告（非脱敏）",
        "",
        "> `confidence` 是当前选择/过滤分，不是 `rank_score`；观察模式只用于展示同一候选池的分布。",
        "",
        f"- scope 数量：`{payload['scope_count']}`",
        f"- 查询数量：`{payload['query_count']}`",
        f"- top-k：`{payload['top_k']}`",
        f"- candidate-limit：`{payload['candidate_limit']}`",
        f"- BM25 参数探针：`K1={PROBE_BM25_K1}`、`B={PROBE_BM25_B}`；线上当前为 `K1={ONLINE_BM25_K1}`、`B={ONLINE_BM25_B}`。",
        "",
        "> 本报告由显式 `--full-report` 生成，仅保存在指定本地路径，不写入 Git。",
    ]
    for scope in payload["scopes"]:
        lines.extend(["", f"## Scope：{md(scope['scope_label'])}"])
        for query in scope["queries"]:
            views = query["confidence_views"]
            lines.extend([
                "",
                f"### 查询：{md(query['label'])}",
                f"query_fp：`{query['query_fp']}`，候选：`{views['candidate_count']}`，",
                f"分布：`{views['distribution']}`",
                "",
                "|观察排名|原召回排名|来源|标题|raw|fused|旧rank_score|probe-rank_score|lexical-v4|conf|conf-v4|source_quality|区间|当前是否入选|",
                "|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
            ])
            for rank, row in enumerate(views["top_k_observation"], 1):
                lines.append(
                    f"|{rank}|{row['original_rank']}|{md(row['source_type'])}|"
                    f"{md(row.get('title', row.get('source_fp')))}|{row['raw_score']:.6f}|"
                    f"{row['fused_score']:.6f}|{row['rank_score']:.6f}|{row['rank_score_probe']:.6f}|"
                    f"{row['lexical_norm_v4']:.6f}|{row['confidence']:.6f}|{row['confidence_v4']:.6f}|"
                    f"{row['source_quality']:.6f}|{row['confidence_band']}|"
                    f"{'是' if row['current_confidence_selection'] else '否'}|"
                )
            lines.extend([
                "",
                f"当前 confidence 选择：`{len(views['confidence_selected'])}` 条；"
                f"stats：`{views['confidence_stats']}`",
            ])
            if views["confidence_selected"]:
                lines.extend(["", "当前入选内容："])
                for row in views["confidence_selected"]:
                    lines.append(f"- `{row['source_type']}` {md(row.get('title', row.get('source_fp')))}，conf=`{row['confidence']:.6f}`")
            if any(row.get("content") for row in views["top_k_observation"]):
                lines.extend(["", "#### 候选正文"])
                for rank, row in enumerate(views["top_k_observation"], 1):
                    lines.extend([f"", f"##### {rank}. {md(row.get('title'))}", "", md(row.get("content"))])
    return "\n".join(lines) + "\n"


def _run_markdown(payload: dict[str, Any]) -> str:
    def md(value: object) -> str:
        return str(value or "").replace("|", "\\|").replace("\n", "<br>")

    lines = [
        "# LoopScope run · RAG confidence 对照报告（非脱敏）",
        "",
        "> 当前结果是用指定 LoopScope run 的 query 对当前 TS 索引只读重跑；下方正文严格按观察排名对应。",
        "",
        f"- 输入 run：`{md(payload['input_run'])}`",
        f"- case 数量：`{payload['case_count']}`",
        f"- top-k：`{payload['top_k']}`",
        f"- candidate-limit：`{payload['candidate_limit']}`",
        "- conf-v1：`0.55*fused + 0.25*query_match + 0.20*source_quality`",
        f"- BM25 参数探针：`K1={PROBE_BM25_K1}`、`B={PROBE_BM25_B}`；线上当前为 `K1={ONLINE_BM25_K1}`、`B={ONLINE_BM25_B}`。",
        "- conf-v4（离线比较）：无 embedding 时 `0.40*lexical_norm + 0.20*query_match + 0.40*source_quality_v4`；有 embedding 时 `fused=0.45*lexical_norm + 0.55*semantic_norm`，再代入同一公式。",
        "- run 回放优先恢复对应 query 的 `before_message_id` 历史水位，避免把 query 之后才产生的对话当成历史召回；无法对齐时才退回正文 hash 排除。",
        "- 观察排名按 `conf-v4` 降序；同分时按 `rank_score_probe`、原召回排名稳定排序。",
        "- rank_score_probe：基于 TS 返回的贡献项离线重算非线性 IDF rank 分；本报告只模拟，不改变线上选择。",
        "- lexical_norm：当前候选池中 `rank_score_probe / top_rank_score_probe`，因此 conf-v4 的词法主信号已经对应探针参数。",
        "- source_quality_v4：project=0.8、memory=0.9、knowledge=1.0、file=0.8、canvas=0.5、calendar=0.5、journal=0.8；conversation 和未知来源=0.5。",
        "- IDF 覆盖仍保留作诊断：候选命中 query token 的 `IDF²` 之和 / 当前完整语料中已索引 query token 的 `IDF²` 之和。",
    ]
    for index, case in enumerate(payload["cases"], 1):
        lines.extend([
            "",
            f"## Case {index} · Round {case.get('round') or '-'}",
            "",
            f"### 原始 query：{md(case.get('query'))}",
            f"run：`{md(case.get('run_id'))}`，trace：`{md(case.get('trace_id'))}`",
            f"回放边界：`before_message_id={case.get('replay_before_message_id') or '-'}`；"
            f"hash 兜底排除：`{case.get('replay_exclude_count', 0)}` 条",
        ])
        current = case.get("current_confidence_recheck") or {}
        views = current.get("confidence_views") or {}
        lines.extend([
            "",
            "### 当前 TS conf 重跑结果",
            "",
            f"候选分布：`{views.get('distribution', {})}`；当前 v1 入选：`{len(views.get('confidence_selected', []))}` 条；假设 v4 入选：`{len(views.get('confidence_v4_selected', []))}` 条",
            "",
            "#### 分数与选择",
            "",
            "|观察排名|原召回排名|来源|标题|raw|旧fused|旧rank_score|probe-rank_score|lexical-v4|fused-v4|conf-v1|conf-v4|Δ|IDF覆盖|v1区间|v4区间|v1入选|v4假设入选|",
            "|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|",
        ])
        for rank, row in enumerate(views.get("top_k_observation", []), 1):
            lines.append(
                f"|{rank}|{row['original_rank']}|{md(row['source_type'])}|{md(row.get('title'))}|"
                f"{row['raw_score']:.6f}|{row['fused_score']:.6f}|{row['rank_score']:.6f}|"
                f"{row['rank_score_probe']:.6f}|{row['lexical_norm_v4']:.6f}|{row['fused_v4']:.6f}|"
                f"{row['confidence']:.6f}|"
                f"{row['confidence_v4']:.6f}|{row['confidence_v4_delta']:+.6f}|{row['idf_coverage']:.6f}|"
                f"{row['confidence_band']}|{row['confidence_v4_band']}|"
                f"{'是' if row['current_confidence_selection'] else '否'}|"
                f"{'是' if row['confidence_v4_selection'] else '否'}|"
            )
        lines.extend(["", "#### 观察排名召回内容", ""])
        for rank, row in enumerate(views.get("top_k_observation", []), 1):
            lines.extend([
                f"**{rank}. {md(row['source_type'])} / {md(row.get('title'))}**",
                "",
                md(row.get("content")),
                "",
            ])
    return "\n".join(lines) + "\n"


async def main() -> None:
    parser = argparse.ArgumentParser(description="只读检查 RAG confidence 分数")
    parser.add_argument("--user", default="", help="用户 ID；不传时读取最早用户，仅建议诊断环境使用")
    parser.add_argument("--top-k", type=int, choices=range(1, 51), default=10)
    parser.add_argument("--candidate-limit", type=int, choices=range(1, 101), default=20)
    parser.add_argument("--query", action="append", default=[], help="只测试指定 query，可重复传入")
    parser.add_argument("--run", default="", help="LoopScope runs 导出 JSON；以其中的对话和 RAG 注入为测试输入")
    parser.add_argument("--full-report", default="", help="写入包含正文的本地 Markdown 报告")
    args = parser.parse_args()
    if args.candidate_limit < args.top_k:
        parser.error("--candidate-limit 不能小于 --top-k")

    db_session.ensure_engine()
    if args.run:
        run_path = Path(args.run).expanduser().resolve()
        if not run_path.is_file():
            parser.error(f"run 文件不存在：{run_path}")
        try:
            payload = await _probe_run(
                str(run_path),
                override_user_id=args.user,
                top_k=args.top_k,
                candidate_limit=args.candidate_limit,
                full=bool(args.full_report),
            )
            payload.update({
                "engine": "typescript-rag-confidence-run-recheck",
                "top_k": args.top_k,
                "candidate_limit": args.candidate_limit,
            })
            if args.full_report:
                report_path = Path(args.full_report).expanduser().resolve()
                report_path.parent.mkdir(parents=True, exist_ok=True)
                report_path.write_text(_run_markdown(payload), encoding="utf-8")
                print(json.dumps({"report": str(report_path), "case_count": payload["case_count"]}, ensure_ascii=False))
            else:
                print(json.dumps(payload, ensure_ascii=False))
        finally:
            await close_rank_clients()
            await close_lexical_clients()
        return

    async with db_session._SessionLocal() as db:
        user_id = args.user
        if not user_id:
            user_id = str((await db.execute(select(User.id).order_by(User.created_at))).scalars().first())
    queries = tuple((f"custom-{index}", value) for index, value in enumerate(args.query, 1)) or QUERIES
    scopes = await _load_scopes(user_id)
    try:
        outputs = []
        for label, scope in scopes:
            result = await _query_scope(
                user_id,
                scope,
                queries,
                top_k=args.top_k,
                candidate_limit=args.candidate_limit,
                full=bool(args.full_report),
            )
            result["scope_label"] = label
            outputs.append(result)
        payload = {
            "engine": "typescript-rag-confidence",
            "user_fp": fp(user_id),
            "query_count": len(queries),
            "scope_count": len(outputs),
            "top_k": args.top_k,
            "candidate_limit": args.candidate_limit,
            "scopes": outputs,
        }
        if args.full_report:
            path = Path(args.full_report).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(_markdown(payload), encoding="utf-8")
            print(json.dumps({"report": str(path), "scope_count": len(outputs)}, ensure_ascii=False))
        else:
            print(json.dumps(payload, ensure_ascii=False))
    finally:
        await close_rank_clients()
        await close_lexical_clients()


if __name__ == "__main__":
    asyncio.run(main())
