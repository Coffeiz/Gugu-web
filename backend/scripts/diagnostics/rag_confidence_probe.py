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

说明：``--candidate-limit`` 是生产召回候选上限；观察模式默认另外请求
TS ranker 最多 50 条结果，避免把“ranker 截断”误报成“来源没有召回”。
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
from agent.rag.models import RecallCandidate, RecallResult, Scope, content_hash
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
# 非线性词法 rank 分的指数：sum(weighted^p)，p<2 会压低头部项的放大效应。
PROBE_RANK_P = 1.5
V4_PREFERRED_THRESHOLD = 0.55
LOW_SCORE_THRESHOLD = 0.35
V4_LEXICAL_WEIGHT = 0.75
V4_QUERY_MATCH_WEIGHT = 0.25
# 生产 confidence 选择的去重预算（max_per_source/max_per_parent=3）；v4 假设
# 入选按同口径去重，否则观察榜单里同文档的多个 chunk 会挤占 top-k 名额，
# 让 v4 与 v1 的入选数对比失真。
V4_MAX_PER_SOURCE = 3
V4_MAX_PER_PARENT = 3
# 生产 confidence 选择的字符预算（max_chars=3000）：同文档第二条 chunk 通常
# 是被这条预算挡掉的（第一条长正文耗尽预算），只复刻条数预算会漏掉这种去重。
V4_MAX_CHARS = 3000
# 生产 selectUnifiedRecall 的近似重复拒重线（token 集合相似度）；同一文件被
# 复制到两个空间时两份拷贝只差一行头部，就是靠这道在注入层挡住的。
V4_SIMILARITY_THRESHOLD = 0.85
QUERY_MATCH_LENGTH_GAMMA = 0.25
QUERY_MATCH_LENGTH_PENALTY_FLOOR = 0.65
MAX_RANKER_OBSERVATION_LIMIT = 50


def ranker_observation_limit(requested: int, top_k: int) -> int:
    """返回诊断观察模式的 ranker 上限，不与生产候选上限混用。

    TS worker 的协议上限是 50。观察模式需要覆盖旧 rank_score 排序下的
    后段候选，否则候选池里存在的 Knowledge 可能在 ranker 截断后消失。
    """
    return min(
        MAX_RANKER_OBSERVATION_LIMIT,
        max(int(top_k), int(requested)),
    )


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
    if score >= LOW_SCORE_THRESHOLD:
        return "fallback"
    return "rejected_low_score"


def confidence_band_v4(value: object) -> str:
    """将 v4 confidence 映射到首选线和 0.35 低分线（阈值取自常量）。"""
    try:
        score = float(value)
    except (TypeError, ValueError):
        score = 0.0
    if score >= V4_PREFERRED_THRESHOLD:
        return "preferred"
    if score >= LOW_SCORE_THRESHOLD:
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


def document_length_ratio(item: dict[str, Any]) -> float:
    """从 TS 的 term contribution 反推出文档长度/语料平均长度。"""
    ratios: list[float] = []
    for contribution in item.get("rank_contributions") or []:
        if not isinstance(contribution, dict):
            continue
        try:
            term_frequency = float(
                contribution.get("term_frequency", contribution.get("termFrequency")) or 0.0
            )
            idf = float(contribution.get("idf") or 0.0)
            query_weight = float(
                contribution.get("query_weight", contribution.get("queryWeight")) or 0.0
            )
            weighted = float(contribution.get("weighted") or 0.0)
        except (TypeError, ValueError):
            continue
        if term_frequency <= 0 or idf <= 0 or query_weight <= 0 or weighted <= 0:
            continue

        online_norm = (
            idf * term_frequency * (ONLINE_BM25_K1 + 1.0) * query_weight / weighted
        )
        ratio = (
            ((online_norm - term_frequency) / ONLINE_BM25_K1)
            - (1.0 - ONLINE_BM25_B)
        ) / ONLINE_BM25_B
        if ratio >= 0:
            ratios.append(ratio)
    if not ratios:
        return 1.0
    ratios.sort()
    middle = len(ratios) // 2
    if len(ratios) % 2:
        return round(ratios[middle], 6)
    return round((ratios[middle - 1] + ratios[middle]) / 2.0, 6)


def query_match_length_penalty(length_ratio: float) -> float:
    """只衰减长于平均长度的候选，不奖励短文，且设置最低惩罚下限。"""
    ratio = max(1.0, _score(length_ratio))
    penalty = ratio ** -QUERY_MATCH_LENGTH_GAMMA
    return round(max(QUERY_MATCH_LENGTH_PENALTY_FLOOR, min(1.0, penalty)), 6)


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
    """用非线性 IDF 词法分、query 覆盖和来源质量计算 conf 的离线比较版。

    当前 run 重跑固定使用 ``strategy=bm25``，因此没有 embedding 分支时直接
    使用 lexical_norm；若后续诊断链提供 semantic_norm，则按 0.45/0.55
    融合。原始 rank_score 不直接进入 conf，先归一化到 0~1。文档长度
    由 BM25 的长度归一化负责，本层不重复惩罚。
    """
    lexical = min(1.0, max(0.0, float(lexical_norm)))
    semantic = min(1.0, max(0.0, float(semantic_norm)))
    fused = lexical if semantic <= 0 else 0.45 * lexical + 0.55 * semantic
    source_quality = _score(item.get("source_quality_v4", item.get("source_quality")))
    match = _score(item.get("query_match"))
    value = (
        V4_LEXICAL_WEIGHT * fused
        + V4_QUERY_MATCH_WEIGHT * match
    ) * source_quality
    return round(max(0.0, value), 6), round(fused, 6)


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
        total += probe_weighted ** PROBE_RANK_P
    return round(total, 6)


def source_quality_v4(item: dict[str, Any]) -> float:
    """v4 离线质量先验；未知来源使用 0.6。"""
    source_quality = {
        "project": 0.8,
        "memory": 0.8,
        "knowledge": 1.0,
        "file": 0.8,
        "canvas": 0.6,
        "calendar": 0.8,
        "journal": 0.8,
        "note": 0.8,
        "conversation": 0.6,
    }
    return source_quality.get(str(item.get("source_type") or ""), 0.6)


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
        raw_match = _score(row.get("query_match"))
        length_ratio = document_length_ratio(row)
        length_penalty = query_match_length_penalty(length_ratio)
        row["document_length_ratio_v4"] = length_ratio
        row["query_match_length_penalty_v4"] = length_penalty
        row["query_match_adjusted_v4"] = round(raw_match * length_penalty, 6)
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
        row["confidence_v4_band"] = confidence_band_v4(value)


def sort_by_confidence_v4(rows: list[dict[str, Any]]) -> None:
    """按 v4 confidence 排观察榜单；后两项保证同分时结果稳定。"""
    rows.sort(
        key=lambda row: (
            -_score(row.get("confidence_v4")),
            -_score(row.get("rank_score_probe")),
            int(row.get("original_rank") or 0),
        )
    )


def _compact_text(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _similarity_key(document: Any) -> tuple[str, frozenset[str]]:
    """近似 TS 侧选择去重的键：紧凑正文 hash + 字符 bigram 集合。"""
    text = _compact_text(getattr(document, "content", "") or "")
    digest_hex = hashlib.md5(text.encode("utf-8")).hexdigest()
    bigrams = [text[index:index + 2] for index in range(len(text) - 1)] or ([text] if text else [])
    return digest_hex, frozenset(bigrams)


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.0
    intersection = len(left & right)
    return intersection / (len(left) + len(right) - intersection)


def mark_confidence_v4_selection(
    rows: list[dict[str, Any]],
    *,
    top_k: int,
    token_map: dict[str, tuple[str, frozenset[str]]] | None = None,
) -> None:
    """按 v4 分数标假设入选，并复刻生产选择的全套去重预算。

    观察榜单故意保留同文档多 chunk 和跨文档的近似重复（便于看完整分布），
    但 v4 的入选口径必须与 TS selectUnifiedRecall 一致：hash 去重、token
    相似度 ≥0.85 拒重（同一文件被复制到两个空间就是靠这道挡住的）、
    max_per_source/max_per_parent=3、max_chars=3000；否则入选数虚高，
    v4 与 v1 的对比失真。
    """
    preferred = [row for row in rows if row["confidence_v4"] >= V4_PREFERRED_THRESHOLD]
    fallback = [row for row in rows
                if LOW_SCORE_THRESHOLD <= row["confidence_v4"] < V4_PREFERRED_THRESHOLD]
    source_budget: dict[str, int] = {}
    parent_budget: dict[str, int] = {}
    selected_hashes: set[str] = set()
    selected_tokens: list[frozenset[str]] = []
    selected = 0
    selected_chars = 0
    for row in (preferred or fallback):
        if selected >= top_k or selected_chars >= V4_MAX_CHARS:
            break
        source_key = f"{row.get('source_type', '')}:{row.get('source_fp', '')}"
        if source_budget.get(source_key, 0) >= V4_MAX_PER_SOURCE:
            continue
        parent_key = f"{source_key}:{row.get('parent_fp', '')}"
        if parent_budget.get(parent_key, 0) >= V4_MAX_PER_PARENT:
            continue
        sim_key = (token_map or {}).get(str(row.get("chunk_fp", "")))
        if sim_key is not None:
            digest_hex, tokens = sim_key
            if digest_hex in selected_hashes:
                continue
            if any(_jaccard(tokens, previous) >= V4_SIMILARITY_THRESHOLD
                   for previous in selected_tokens):
                continue
        row["confidence_v4_selection"] = True
        source_budget[source_key] = source_budget.get(source_key, 0) + 1
        parent_budget[parent_key] = parent_budget.get(parent_key, 0) + 1
        selected += 1
        selected_chars += int(row.get("content_len") or 0)
        if sim_key is not None:
            selected_hashes.add(sim_key[0])
            selected_tokens.append(sim_key[1])
    for row in rows:
        row.setdefault("confidence_v4_selection", False)


def _candidate_key(item: dict[str, Any]) -> tuple[str, str]:
    citation = item.get("citation") or {}
    return str(citation.get("source_type") or ""), str(citation.get("chunk_id") or "")


def _is_excluded_conversation_session(candidate: RecallCandidate, session_id: object | None) -> bool:
    """判断 run 回放候选是否属于需要排除的当前会话。"""
    if session_id is None:
        return False
    document = candidate.document
    return (
        document.source_type == "conversation"
        and str(document.metadata.get("session_id") or "") == str(session_id)
    )


# ``--no-embedding`` 时置 True：同语料 A/B 对照用，其余路径行为不变。
HYBRID_DISABLED = False


async def _hybrid_semantic_context(
    owner_id: str,
    query: str,
    candidates: list[RecallCandidate],
) -> tuple[dict[str, Any] | None, str | None]:
    """生成 embedding 混合评分输入，返回 (上下文, 回退原因)。

    与生产 hybrid 同口径：只复用已有缓存向量（memory/knowledge/pattern）
    的候选；诊断路径不按需生成向量、不写任何向量缓存。embedding 未启用、
    query 向量生成失败或候选池没有缓存向量时回退纯词法 conf-v4。
    """
    if HYBRID_DISABLED:
        return None, "flag_disabled"
    if not candidates:
        return None, "no_candidates"
    if not embedding.is_enabled():
        return None, "embedding_disabled"
    query_vector = await embedding.embed(query)
    if not query_vector:
        return None, "query_embedding_failed"
    vector_map = await _load_cached_vectors(
        owner_id, [candidate.document for candidate in candidates],
    )
    if not vector_map:
        return None, "embedding_cache_unavailable"
    raw_scores: dict[str, float] = {}
    for candidate in candidates:
        vector = vector_map.get(candidate.document.chunk_id)
        if not vector:
            continue
        key = f"{candidate.document.source_type}:{fp(candidate.document.chunk_id)}"
        raw_scores[key] = cosine(query_vector, vector)
    maximum = max(raw_scores.values(), default=0.0)
    if maximum <= 0:
        return None, "no_vector_candidates"
    return {
        "model_tag": embedding.model_tag(),
        "vector_hits": len(raw_scores),
        "candidate_count": len(candidates),
        "raw_scores": raw_scores,
        "semantic_scores": {
            key: round(score / maximum, 6) for key, score in raw_scores.items()
        },
        "query_vector": query_vector,
        "vector_map": vector_map,
    }, None


async def _apply_hybrid_scoring(
    owner_id: str,
    query: str,
    rows: list[dict[str, Any]],
    candidates: list[RecallCandidate],
) -> tuple[dict[str, Any] | None, str | None]:
    """给观察行注入 embedding 分与 hybrid RRF 参考分，并完成 conf-v4 融合。

    排序消费的 confidence_v4 在有语义分时即混合结果
    （0.45*lexical_norm + 0.55*semantic_norm 再乘来源质量与 query 覆盖）；
    rrf 列来自生产 ``hybrid_results`` 的 RRF 融合分，只作对照，不进入 conf-v4。
    """
    hybrid_ctx, fallback = await _hybrid_semantic_context(owner_id, query, candidates)
    hybrid_rrf: dict[str, float] = {}
    if hybrid_ctx is not None:
        lexical_results = [
            RecallResult(candidate.document, _score(candidate.raw_score))
            for candidate in candidates
        ]
        fused_results, _ = hybrid_results(
            lexical_results,
            [candidate.document for candidate in candidates],
            hybrid_ctx["query_vector"],
            hybrid_ctx["vector_map"],
            limit=len(lexical_results),
        )
        hybrid_rrf = {
            fp(item.document.chunk_id): round(item.score, 6)
            for item in fused_results
        }
    for row in rows:
        key = f"{row.get('source_type', '')}:{row.get('chunk_fp', '')}"
        raw = hybrid_ctx["raw_scores"].get(key) if hybrid_ctx else None
        row["semantic_hit"] = raw is not None
        row["embedding_score"] = round(_score(raw), 6) if raw is not None else None
        row["hybrid_rrf"] = hybrid_rrf.get(str(row.get("chunk_fp", "")))
    apply_confidence_v4(
        rows,
        semantic_scores=hybrid_ctx["semantic_scores"] if hybrid_ctx else None,
    )
    return hybrid_ctx, fallback


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
    observation_limit: int,
    full: bool,
    exclude_content_hashes: set[str] | None = None,
    exclude_conversation_session_id: object | None = None,
) -> dict[str, Any]:
    """用完整 unified RAG 候选池输出 v1/v4 与未过滤 rank top-k。

    ``exclude_conversation_session_id`` 只用于 run 回放诊断：它在评分前从
    观察候选池移除当前 session 的 conversation 消息和 summary，避免同一
    个导出 run 的前序对话被误当成外部历史召回。线上 RAG 不读取这个脚本参数。
    """
    retriever = _full_unified_retriever(owner_id)
    observation_limit = ranker_observation_limit(observation_limit, top_k)
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
            # 观察模式单独放宽 ranker 输出上限；candidate_limit 仍保持生产
            # 召回边界，用来回答“候选池里有没有这条”，而不是复现旧 ranker
            # 的前 20 条截断。
            "limit": observation_limit,
            # 观察模式要拿到未过滤 top-k，不能让第一条长正文耗尽生产预算。
            "max_chars": max(100_000, top_k * 10_000),
            "max_per_source": candidate_limit,
            "max_per_parent": candidate_limit,
            "selection_mode": "top_k",
            "exclude_content_hashes": sorted(exclude_content_hashes or set()),
        },
    ))[0]
    observed = list(observed_batch.rank_rows)
    confidence_rows = list(confidence_batch.rank_rows)

    def belongs_to_excluded_session(row) -> bool:
        return _is_excluded_conversation_session(
            row[0], exclude_conversation_session_id,
        )

    excluded_count = sum(belongs_to_excluded_session(row) for row in observed)
    observed = [row for row in observed if not belongs_to_excluded_session(row)]
    confidence_rows = [row for row in confidence_rows if not belongs_to_excluded_session(row)]
    selected_keys = {
        (candidate.document.source_type, candidate.document.chunk_id)
        for candidate, _text, _item in confidence_rows
    }
    rows: list[dict[str, Any]] = []
    similarity_index: dict[str, tuple[str, frozenset[str]]] = {}
    for candidate, _text, item in observed:
        key = (candidate.document.source_type, candidate.document.chunk_id)
        similarity_index[fp(candidate.document.chunk_id)] = _similarity_key(candidate.document)
        rows.append(_public_candidate(
            candidate,
            item,
            original_rank=candidate.rank,
            current_selected=key in selected_keys,
            full=full,
        ))
    hybrid_ctx, hybrid_fallback = await _apply_hybrid_scoring(
        owner_id, query, rows, [entry[0] for entry in observed],
    )
    sort_by_confidence_v4(rows)
    mark_confidence_v4_selection(rows, top_k=top_k, token_map=similarity_index)
    values = [_score(row["confidence"]) for row in rows]
    return {
        "candidate_count": len(observed),
        "hybrid": {
            "embedding_used": hybrid_ctx is not None,
            "model_tag": hybrid_ctx["model_tag"] if hybrid_ctx else None,
            "vector_hits": hybrid_ctx["vector_hits"] if hybrid_ctx else 0,
            "candidate_count": len(observed),
            "fallback": hybrid_fallback,
        },
        "excluded_conversation_session_id": (
            str(exclude_conversation_session_id)
            if exclude_conversation_session_id is not None else None
        ),
        "excluded_conversation_count": excluded_count,
        "confidence_selected": [
            _public_candidate(
                candidate,
                item,
                original_rank=candidate.rank,
                current_selected=True,
                full=full,
            )
            for candidate, _text, item in confidence_rows
        ],
        "confidence_v4_selected": [row for row in rows if row["confidence_v4_selection"]],
        "top_k_observation": rows[:top_k],
        "confidence_stats": confidence_batch.rank_stats or {},
        "top_k_stats": observed_batch.rank_stats or {},
        "observation_limit": observation_limit,
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
        "parent_fp": fp(document.parent_document_id or document.document_id),
        "content_fp": fp(document.content),
        "content_len": len(document.content or ""),
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
    similarity_index: dict[str, tuple[str, frozenset[str]]] = {}
    for candidate, _, item in observed:
        key = _candidate_key(item)
        source_candidate = candidate_by_key.get(key, candidate)
        similarity_index[fp(source_candidate.document.chunk_id)] = _similarity_key(source_candidate.document)
        rows.append(_public_candidate(
            source_candidate,
            item,
            original_rank=original_ranks.get(key, source_candidate.rank),
            current_selected=key in selected_keys,
            full=full,
        ))
    hybrid_ctx, hybrid_fallback = await _apply_hybrid_scoring(
        owner_id, query, rows, candidates,
    )
    sort_by_confidence_v4(rows)
    mark_confidence_v4_selection(rows, top_k=top_k, token_map=similarity_index)
    values = [_score(row["confidence"]) for row in rows]
    return {
        "candidate_count": len(candidates),
        "hybrid": {
            "embedding_used": hybrid_ctx is not None,
            "model_tag": hybrid_ctx["model_tag"] if hybrid_ctx else None,
            "vector_hits": hybrid_ctx["vector_hits"] if hybrid_ctx else 0,
            "candidate_count": len(candidates),
            "fallback": hybrid_fallback,
        },
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
    observation_limit: int,
    full: bool,
    exclude_content_hashes: set[str] | None = None,
    exclude_conversation_session_id: object | None = None,
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
            user_id, query, top_k=top_k, candidate_limit=candidate_limit,
            observation_limit=observation_limit, full=full,
            exclude_content_hashes=exclude_content_hashes,
            exclude_conversation_session_id=exclude_conversation_session_id,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        hybrid = views.get("hybrid") or {}
        output["queries"].append({
            "label": query_label,
            "query_fp": fp(query),
            "lexical_ms": elapsed_ms,
            "embedding_used": bool(hybrid.get("embedding_used")),
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
    observation_limit: int,
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
                observation_limit=observation_limit,
                full=full,
                # 能恢复历史水位时优先使用它；只有 run 没带 session/message
                # 对齐信息时，才用正文 hash 作为回放污染的保守兜底。
                exclude_content_hashes=(
                    set() if before_message_id is not None
                    else set(case.get("replay_exclude_content_hashes") or ())
                ),
                # run 回放默认排除整个当前 session；只恢复 before_message_id
                # 会让同一 run 的前序 query 继续进入后续 query 的候选池。
                exclude_conversation_session_id=case.get("session_id"),
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
            "replay_excluded_session_id": case.get("session_id"),
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
        f"- ranker 观察上限：`{payload['observation_limit']}`（生产候选上限与观察上限分离）",
        f"- BM25 参数探针：`K1={PROBE_BM25_K1}`、`B={PROBE_BM25_B}`；线上当前为 `K1={ONLINE_BM25_K1}`、`B={ONLINE_BM25_B}`。",
        f"- conf-v4：`({V4_LEXICAL_WEIGHT:.2f}*fused + {V4_QUERY_MATCH_WEIGHT:.2f}*query_match) * source_quality_v4`；有缓存向量的候选按 `0.45*lexical_norm + 0.55*semantic_norm` 融合（cosine 池内归一化），rrf 列为生产 RRF 融合参考分。",
        "",
        "> 本报告由显式 `--full-report` 生成，仅保存在指定本地路径，不写入 Git。",
    ]
    for scope in payload["scopes"]:
        lines.extend(["", f"## Scope：{md(scope['scope_label'])}"])
        for query in scope["queries"]:
            views = query["confidence_views"]
        hybrid = views.get("hybrid") or {}
        hybrid_state = (
            f"已启用（向量命中 `{hybrid.get('vector_hits')}/{hybrid.get('candidate_count')}`）"
            if hybrid.get("embedding_used")
            else f"未启用（`{hybrid.get('fallback') or 'embedding_disabled'}`）"
        )
        lines.extend([
            "",
            f"### 查询：{md(query['label'])}",
            f"query_fp：`{query['query_fp']}`，候选：`{views['candidate_count']}`，",
            f"分布：`{views['distribution']}`",
            f"embedding：{hybrid_state}",
            "",
            "|观察排名|原召回排名|来源|标题|raw|fused|旧rank_score|probe-rank_score|lexical-v4|emb-cos|sem-norm|rrf|query-match|match-adjusted|len-penalty|conf|conf-v4|source_quality|区间|当前是否入选|",
            "|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
        ])

        def hybrid_cell(value: object) -> str:
            return f"{value:.6f}" if isinstance(value, (int, float)) else "-"

        for rank, row in enumerate(views["top_k_observation"], 1):
            lines.append(
                f"|{rank}|{row['original_rank']}|{md(row['source_type'])}|"
                f"{md(row.get('title', row.get('source_fp')))}|{row['raw_score']:.6f}|"
                f"{row['fused_score']:.6f}|{row['rank_score']:.6f}|{row['rank_score_probe']:.6f}|"
                f"{row['lexical_norm_v4']:.6f}|"
                f"{hybrid_cell(row.get('embedding_score') if row.get('semantic_hit') else None)}|"
                f"{hybrid_cell(row.get('semantic_norm_v4') if row.get('semantic_hit') else None)}|"
                f"{hybrid_cell(row.get('hybrid_rrf'))}|"
                f"{row['query_match']:.6f}|"
                f"{row['query_match_adjusted_v4']:.6f}|{row['query_match_length_penalty_v4']:.6f}|"
                f"{row['confidence']:.6f}|{row['confidence_v4']:.6f}|"
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
            f"- ranker 观察上限：`{payload['observation_limit']}`（生产候选上限与观察上限分离）",
        "- conf-v1：`0.55*fused + 0.25*query_match + 0.20*source_quality`",
        f"- BM25 参数探针：`K1={PROBE_BM25_K1}`、`B={PROBE_BM25_B}`；线上当前为 `K1={ONLINE_BM25_K1}`、`B={ONLINE_BM25_B}`。",
        f"- conf-v4（实验比较）：`({V4_LEXICAL_WEIGHT:.2f}*fused + {V4_QUERY_MATCH_WEIGHT:.2f}*query_match) * source_quality_v4`；`fused` 无 embedding 时就是 `lexical_norm`，有 embedding 时先按 `0.45*lexical_norm + 0.55*semantic_norm` 融合；`len_penalty` 只作诊断，不进入本次公式。",
        "- embedding 混合：有缓存向量（memory/knowledge/pattern）的候选按池内 `cosine / 最大 cosine` 归一成 semantic_norm 后融合；无向量候选保持纯词法，与生产 hybrid 同口径（诊断路径不生成向量、不写缓存）。",
        "- rrf 列：生产 `hybrid_results` 的 RRF 融合参考分（词法 0.45 / 向量 0.55），只作对照，不进入 conf-v4。",
        f"- v4 过滤线：首选 `confidence >= {V4_PREFERRED_THRESHOLD:.2f}`；fallback 为 `{LOW_SCORE_THRESHOLD:.2f} <= confidence < {V4_PREFERRED_THRESHOLD:.2f}`。",
        "- run 回放优先恢复对应 query 的 `before_message_id` 历史水位，并额外排除当前 run 所属 session 的全部 conversation；无法对齐时才退回正文 hash 排除。",
        "- 观察排名按 conf-v4 降序（有 embedding 时即混合结果排序）；同分时按 `rank_score_probe`、原召回排名稳定排序。",
        "- v4 假设入选复刻生产 confidence 选择的去重预算（max_per_source/max_per_parent=3 + max_chars=3000 字符预算）；观察榜单本身仍保留同文档多 chunk 供分布诊断。",
        "- rank_score_probe：基于 TS 返回的贡献项离线重算非线性 IDF rank 分；本报告只模拟，不改变线上选择。",
        "- lexical_norm：当前候选池中 `rank_score_probe / top_rank_score_probe`，因此 conf-v4 的词法主信号已经对应探针参数。",
        f"- 长度诊断：仅对超过语料平均长度的候选计算 `len_penalty=max({QUERY_MATCH_LENGTH_PENALTY_FLOOR:.2f}, ratio^-{QUERY_MATCH_LENGTH_GAMMA:.2f})`，本实验不把它乘入 conf。",
        "- source_quality_v4：knowledge=1.0；memory/project/file/journal/calendar/note=0.8；canvas/conversation/未知来源=0.6。",
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
            f"当前 session 排除：`{case.get('replay_excluded_session_id') or '-'}`；"
            f"hash 兜底排除：`{case.get('replay_exclude_count', 0)}` 条",
        ])
        current = case.get("current_confidence_recheck") or {}
        views = current.get("confidence_views") or {}
        hybrid = views.get("hybrid") or {}
        if hybrid.get("embedding_used"):
            embedding_line = (
                f"embedding：已启用 `model_tag={hybrid.get('model_tag')}`，"
                f"向量命中 `{hybrid.get('vector_hits')}/{hybrid.get('candidate_count')}`"
            )
        else:
            embedding_line = (
                f"embedding：未启用（`{hybrid.get('fallback') or 'embedding_disabled'}`），"
                "本 case 按纯词法 conf-v4 排序"
            )
        lines.extend([
            "",
            "### 当前 TS conf 重跑结果",
            "",
            f"候选分布：`{views.get('distribution', {})}`；排除当前 session conversation：`{views.get('excluded_conversation_count', 0)}` 条；"
            f"当前 v1 入选：`{len(views.get('confidence_selected', []))}` 条；假设 v4 入选：`{len(views.get('confidence_v4_selected', []))}` 条",
            embedding_line,
            "",
            "#### 分数与选择",
            "",
            "|观察排名|原召回排名|来源|标题|raw|旧fused|旧rank_score|probe-rank_score|lexical-v4|emb-cos|sem-norm|rrf|query-match|match-adjusted|len-penalty|fused-v4|conf-v1|conf-v4|Δ|IDF覆盖|v1区间|v4区间|v1入选|v4假设入选|",
            "|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|",
        ])

        def hybrid_cell(value: object) -> str:
            return f"{value:.6f}" if isinstance(value, (int, float)) else "-"

        for rank, row in enumerate(views.get("top_k_observation", []), 1):
            lines.append(
                f"|{rank}|{row['original_rank']}|{md(row['source_type'])}|{md(row.get('title'))}|"
                f"{row['raw_score']:.6f}|{row['fused_score']:.6f}|{row['rank_score']:.6f}|"
                f"{row['rank_score_probe']:.6f}|{row['lexical_norm_v4']:.6f}|"
                f"{hybrid_cell(row.get('embedding_score') if row.get('semantic_hit') else None)}|"
                f"{hybrid_cell(row.get('semantic_norm_v4') if row.get('semantic_hit') else None)}|"
                f"{hybrid_cell(row.get('hybrid_rrf'))}|"
                f"{row['query_match']:.6f}|{row['query_match_adjusted_v4']:.6f}|"
                f"{row['query_match_length_penalty_v4']:.6f}|{row['fused_v4']:.6f}|"
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
    parser.add_argument(
        "--observation-limit", type=int, choices=range(1, MAX_RANKER_OBSERVATION_LIMIT + 1),
        default=MAX_RANKER_OBSERVATION_LIMIT,
        help="观察模式向 TS ranker 请求的结果上限，默认 50；不改变生产候选上限",
    )
    parser.add_argument("--query", action="append", default=[], help="只测试指定 query，可重复传入")
    parser.add_argument("--run", default="", help="LoopScope runs 导出 JSON；以其中的对话和 RAG 注入为测试输入")
    parser.add_argument("--no-embedding", action="store_true", help="关闭 embedding 混合（同语料 A/B 对照）")
    parser.add_argument("--full-report", default="", help="写入包含正文的本地 Markdown 报告")
    args = parser.parse_args()
    global HYBRID_DISABLED
    HYBRID_DISABLED = bool(args.no_embedding)
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
                observation_limit=args.observation_limit,
                full=bool(args.full_report),
            )
            payload.update({
                "engine": "typescript-rag-confidence-run-recheck",
                "top_k": args.top_k,
                "candidate_limit": args.candidate_limit,
                "observation_limit": ranker_observation_limit(args.observation_limit, args.top_k),
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
            observation_limit=args.observation_limit,
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
            "observation_limit": ranker_observation_limit(args.observation_limit, args.top_k),
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
