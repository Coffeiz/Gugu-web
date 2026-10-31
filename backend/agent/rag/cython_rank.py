"""RAG 候选排序与注入预算的 Python facade。

BM25、cosine 与 IDF 贡献数值核由 ``cython_kernel`` 提供；这里保留 TS
rank-candidates 的评分编排、引用和诊断契约，且当前不接生产调用路径。
"""
from __future__ import annotations

import hashlib
import math
import re
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from agent.rag.cython_backend import idf_rescore_document, idf_rescore_query_terms
from agent.rag.cython_collation import locale_sort_key, reverse_locale_sort_key
from agent.rag.cython_tokenizer import tokenize_raw

_SOURCE_QUALITY_V4 = {
    "knowledge": 1.0, "file": 0.8, "memory": 0.8, "project": 0.8,
    "journal": 0.8, "note": 0.8, "calendar": 0.8, "canvas": 0.6,
    "conversation": 0.6,
}
_SOURCE_QUALITY_V1 = {
    "memory": 0.8, "project": 0.9, "canvas": 0.75,
    "conversation": 0.65, "journal": 0.7, "knowledge": 0.8,
}
_SOURCE_PRIORITY = {
    "memory": 0, "project": 10, "calendar": 30, "scheduled_task": 35,
    "journal": 30, "canvas": 40, "conversation": 50,
}
# JavaScript 的 \\s 与 Python Unicode \s 不完全相同（例如 U+0085）。
_JS_WS = r"\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_JS_WS_RE = re.compile(f"[{_JS_WS}]+")
_JS_TRIM_START = re.compile(f"^[{_JS_WS}]+")
_JS_TRIM_END = re.compile(f"[{_JS_WS}]+$")


@dataclass(frozen=True, slots=True)
class _SelectionOptions:
    limit: int | float
    max_chars: int | float
    max_per_source: int | float
    max_per_parent: int | float
    mode: str


@dataclass(slots=True)
class _SelectionState:
    selected: list[dict[str, Any]] = field(default_factory=list)
    hashes: set[str] = field(default_factory=set)
    parent_counts: Counter[str] = field(default_factory=Counter)
    source_counts: Counter[str] = field(default_factory=Counter)
    token_sets: list[set[str]] = field(default_factory=list)
    output_chars: int = 0
    rejected_duplicate: int = 0
    rejected_parent: int = 0
    rejected_source: int = 0
    rejected_similarity: int = 0


def rank_candidates(
    query: str | None,
    candidates: Sequence[Mapping[str, Any]] | None,
    *,
    limit: Any = 5,
    max_chars: Any = 3000,
    max_per_source: Any = 3,
    max_per_parent: Any = 3,
    exclude_content_hashes: Sequence[str] | None = (),
    selection_mode: str | None = "confidence",
    scoring_version: str | None = "confidence-v4",
    corpus_statistics: Mapping[str, Any] | None = None,
    precomputed_term_frequencies: Mapping[str, Mapping[str, int]] | None = None,
    precomputed_document_lengths: Mapping[str, int] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """与 TS ``rankCandidates`` 同契约的候选评分、选择和诊断 facade。

    输入 document 使用 TS wire 字段名，便于同一份脱敏 fixture 双边回放。
    """
    started = time.perf_counter()
    query = "" if query is None else query
    candidates = candidates or ()
    scoring_version = scoring_version or "confidence-v4"
    selection_mode = selection_mode or "confidence"
    if scoring_version not in {"confidence-v1", "confidence-v4"}:
        raise ValueError("不支持的 RAG scoring_version")
    if any(
        not isinstance(candidate, Mapping)
        or not isinstance(candidate.get("document"), Mapping)
        for candidate in candidates
    ):
        # TS rankCandidates 解引用候选正文时会让不完整 wire DTO 以 worker_failure
        # 失败；Python facade 也必须拒绝，而不是把缺失正文当成空文档悄悄参与排序。
        raise TypeError("RAG rank candidate 与 document 必须是对象")
    limit, max_chars, max_per_source, max_per_parent = _normalize_limits(
        limit, max_chars, max_per_source, max_per_parent,
    )
    eligible = _exclude_history(candidates, exclude_content_hashes or ())
    normalized = _normalize_by_source(eligible)
    scored = _score_candidates(
        query, eligible, normalized, scoring_version, corpus_statistics,
        precomputed_term_frequencies or {}, precomputed_document_lengths or {},
    )
    if scoring_version == "confidence-v4":
        _normalize_v4_confidence(scored)
    ordered = sorted(scored, key=_rank_sort_key)
    confidence_selected, preferred = _select_confidence_band(ordered, limit, selection_mode)
    confidence_ids = {item["candidate"]["id"] for item in confidence_selected}
    selected, selection_stats = _select(
        confidence_selected, eligible,
        _SelectionOptions(limit, max_chars, max_per_source, max_per_parent, selection_mode),
    )
    stats = _build_diagnostics(
        candidates, eligible, scored, selected, selection_stats, confidence_ids,
        preferred, selection_mode, scoring_version, corpus_statistics, started,
    )
    return selected, stats


def _normalize_limits(
    limit: Any,
    max_chars: Any,
    max_per_source: Any,
    max_per_parent: Any,
) -> tuple[int | float, int | float, int | float, int | float]:
    raw_limit = _js_number(5 if limit is None else limit)
    normalized_limit = (
        0 if math.isnan(raw_limit) else max(1, min(raw_limit, 50))
    )
    return (
        normalized_limit,
        _js_number_clamped(max_chars, 3000),
        _js_number_clamped(max_per_source, 3),
        _js_number_clamped(max_per_parent, 3),
    )


def _js_number(value: Any) -> float:
    """复刻 JSON wire 可达值上的 JavaScript Number() 基本转换。"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except OverflowError:
            return math.inf if value > 0 else -math.inf
    if isinstance(value, (list, tuple)):
        value = ",".join(_js_string(item) for item in value)
    elif isinstance(value, Mapping):
        return math.nan
    return _js_number_from_string(value) if isinstance(value, str) else math.nan


def _js_number_from_string(value: str) -> float:
    normalized = _JS_TRIM_END.sub("", _JS_TRIM_START.sub("", value))
    if not normalized:
        return 0.0
    if normalized in {"Infinity", "+Infinity"}:
        return math.inf
    if normalized == "-Infinity":
        return -math.inf
    if normalized.lower() in {"inf", "+inf", "-inf"}:
        return math.nan
    if normalized.startswith(("0x", "0X", "0b", "0B", "0o", "0O")):
        try:
            return float(int(normalized, 0))
        except ValueError:
            return math.nan
    if not re.fullmatch(r"[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?", normalized):
        return math.nan
    try:
        return float(normalized)
    except ValueError:
        return math.nan


def _js_string(value: Any) -> str:
    """JSON array 转 Number 时，复刻 Array#toString 的递归逗号拼接。"""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ",".join(_js_string(item) for item in value)
    if isinstance(value, Mapping):
        return "[object Object]"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _js_number_clamped(value: Any, default: int) -> int | float:
    number = _js_number(default if value is None else value)
    if math.isnan(number):
        return math.nan
    return max(1, number)


def _js_slice_length(value: int | float) -> int:
    """JavaScript Array.slice(0, end) 对 NaN/小数的截断语义。"""
    if math.isnan(value) or value <= 0:
        return 0
    return int(value)


def _exclude_history(candidates: Sequence[Mapping[str, Any]], hashes: Sequence[str]) -> list[Mapping[str, Any]]:
    excluded = set(map(str, hashes))
    return [item for item in candidates if not (_content_hashes(item.get("document") or {}) & excluded)]


def _normalize_by_source(candidates: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in candidates:
        groups[str(item.get("source_type") or "")].append(item)
    normalized: dict[str, float] = {}
    for group in groups.values():
        scores = [float(item.get("raw_score") or 0) for item in group]
        low, high = min(scores), max(scores)
        for item in group:
            score = float(item.get("raw_score") or 0)
            normalized[str(item.get("id") or "")] = (
                max(0.0, score) / (1.0 + max(0.0, score))
                if high <= low else (score - low) / (high - low)
            )
    return normalized


def _score_candidates(
    query: str, candidates: Sequence[Mapping[str, Any]], normalized: Mapping[str, float],
    version: str, statistics: Mapping[str, Any] | None,
    precomputed_term_frequencies: Mapping[str, Mapping[str, int]],
    precomputed_document_lengths: Mapping[str, int],
) -> list[dict[str, Any]]:
    scored = []
    query_tokens = tokenize_raw(query)
    for candidate in candidates:
        document = candidate.get("document") or {}
        candidate_id = str(candidate.get("id") or "")
        term_frequencies = precomputed_term_frequencies.get(candidate_id)
        document_tokens = None
        if term_frequencies is None:
            ranking_text = str(document.get("ranking_text") or document.get("text") or "")
            document_tokens = tokenize_raw(ranking_text)
        source = str(candidate.get("source_type") or "")
        normalized_score = normalized.get(candidate_id, 0.0)
        fused = _fused_score(candidate, normalized_score)
        rescore = _rescore(
            query, document, statistics, query_tokens, document_tokens,
            term_frequencies, precomputed_document_lengths.get(candidate_id),
        )
        rank_score = float(rescore["rank_score"]) if rescore else fused
        match = min(1.0, _query_match(
            query, document, query_tokens, document_tokens, term_frequencies,
        ))
        source_quality = _source_quality(source, document, version)
        value = _confidence(rank_score, fused, match, source_quality, version)
        scored.append({
            "candidate": candidate, "normalized_score": normalized_score,
            "fused": fused, "rank_score": rank_score, "rescore": rescore,
            "value": value, "source_quality": source_quality, "match": match,
            "semantic_norm": None,
        })
    return scored


def _source_quality(source: str, document: Mapping[str, Any], version: str) -> float:
    if version == "confidence-v4":
        return _SOURCE_QUALITY_V4.get(source, 0.6)
    quality = _SOURCE_QUALITY_V1.get(source, 0.7)
    if source == "knowledge":
        confidence = str((document.get("metadata") or {}).get("confidence") or "")
        quality *= {"confirmed": 1.0, "probable": 0.85, "unverified": 0.65, "conflict": 0.35}.get(confidence, 0.65)
    return quality


def _confidence(rank_score: float, fused: float, match: float, quality: float, version: str) -> float:
    if version == "confidence-v4":
        value = (0.75 * rank_score + 0.25 * match) * quality
        return min(value, 0.34) if match <= 0 else value
    value = min(1.0, max(0.0, 0.55 * fused + 0.25 * match + 0.20 * quality))
    return min(value, 0.34) if match <= 0 else value


def _normalize_v4_confidence(scored: list[dict[str, Any]]) -> None:
    if not scored:
        return
    top_lexical = max(0.0, *(item["rank_score"] for item in scored))
    if top_lexical <= 0:
        return
    top_semantic = max(0.0, *(float(item["candidate"].get("semantic_score") or 0) for item in scored))
    for item in scored:
        lexical_norm = min(1.0, item["rank_score"] / top_lexical)
        semantic_norm = _semantic_norm(item["candidate"].get("semantic_score"), top_semantic)
        fused_norm = 0.45 * lexical_norm + 0.55 * semantic_norm if semantic_norm is not None else lexical_norm
        item["value"] = _confidence(fused_norm, item["fused"], item["match"], item["source_quality"], "confidence-v4")
        item["semantic_norm"] = semantic_norm


def _semantic_norm(semantic: Any, top_semantic: float) -> float | None:
    if top_semantic <= 0 or semantic is None:
        return None
    normalized = float(semantic) / top_semantic
    if normalized <= 0:
        return None
    return math.floor(min(1.0, normalized) * 1_000_000 + 0.5) / 1_000_000


def _select_confidence_band(
    ordered: Sequence[Mapping[str, Any]], limit: int | float, selection_mode: str,
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    preferred = [item for item in ordered if item["value"] >= 0.55]
    fallback = [item for item in ordered if 0.35 <= item["value"] < 0.55]
    selected = ordered if selection_mode == "top_k" else (preferred or fallback)
    return list(selected[:_js_slice_length(limit)]), preferred


def _build_diagnostics(
    candidates, eligible, scored, selected, selection_stats, selected_ids,
    preferred, selection_mode, scoring_version, corpus_statistics, started,
) -> dict[str, Any]:
    source_diagnostics: dict[str, dict[str, int]] = {}
    for item in candidates:
        source = str(item.get("source_type") or "")
        source_diagnostics.setdefault(source, {"candidate_count": 0, "eligible_count": 0, "accepted_count": 0})["candidate_count"] += 1
    for item in eligible:
        source_diagnostics[str(item.get("source_type") or "")]["eligible_count"] += 1
    for result in selected:
        source_diagnostics[result["citation"]["source_type"]]["accepted_count"] += 1
    confidence_mode = selection_mode == "confidence"
    return {
        **selection_stats,
        "rejected_low_score": sum(item["value"] < 0.35 for item in scored) if confidence_mode else 0,
        "rejected_not_preferred": sum(
            bool(preferred) and item["value"] >= 0.35 and item["candidate"]["id"] not in selected_ids
            for item in scored
        ) if confidence_mode else 0,
        "top_confidence": max((item["value"] for item in scored), default=0.0),
        "threshold": 0.35, "preferred_threshold": 0.55,
        "selection_mode": selection_mode, "scoring_version": scoring_version,
        "rescore_version": "idf-nonlinear-v2" if corpus_statistics else "disabled",
        "idf_source": (corpus_statistics or {}).get("source", "none"),
        "contribution_exponent": 1.5 if corpus_statistics else None,
        "source_diagnostics": source_diagnostics,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
    }


def _fused_score(candidate: Mapping[str, Any], normalized: float) -> float:
    if candidate.get("fused_score") is not None:
        return float(candidate["fused_score"])
    if candidate.get("fusion") == "hybrid-rrf":
        return float(candidate.get("raw_score") or 0)
    return normalized


def _query_match(
    query: str, document: Mapping[str, Any], query_tokens: Sequence[str] | None = None,
    document_tokens: Sequence[str] | None = None,
    document_term_frequencies: Mapping[str, int] | None = None,
) -> float:
    meaningful = {term for term in (query_tokens if query_tokens is not None else tokenize_raw(query)) if not all(
        unicodedata.category(char)[0] in {"N", "P", "S"} or char == "_" for char in term
    )}
    if not meaningful:
        return 0.0
    text = str(document.get("ranking_text") or document.get("text") or "")
    compact_query = _JS_WS_RE.sub("", str(query or "")).lower()
    compact_text = _JS_WS_RE.sub("", text).lower()
    if len(compact_query) >= 2 and compact_query in compact_text:
        return 1.0
    document_terms = (
        set(document_term_frequencies) if document_term_frequencies is not None
        else set(document_tokens if document_tokens is not None else tokenize_raw(text))
    )
    return sum(term in document_terms for term in meaningful) / len(meaningful)


def _rescore(
    query: str, document: Mapping[str, Any], statistics: Mapping[str, Any] | None,
    query_tokens: Sequence[str] | None = None, document_tokens: Sequence[str] | None = None,
    document_term_frequencies: Mapping[str, int] | None = None,
    document_token_length: int | None = None,
) -> dict[str, Any] | None:
    if not statistics or int(statistics.get("document_count") or 0) <= 0:
        return None
    frequencies = statistics.get("document_frequency") or {}
    if (
        query_tokens is not None and document_term_frequencies is not None
        and document_token_length is not None
    ):
        return idf_rescore_query_terms(
            query_tokens, document_term_frequencies, document_token_length,
            document_count=int(statistics["document_count"]),
            average_length=float(statistics.get("average_length") or 0),
            document_frequency=frequencies,
        )
    return idf_rescore_document(
        query, _wire_index_document(document),
        document_count=int(statistics["document_count"]),
        average_length=float(statistics.get("average_length") or 0),
        document_frequency=dict(frequencies),
        query_tokens=query_tokens,
        document_tokens=document_tokens,
        document_term_frequencies=document_term_frequencies,
        document_token_length=document_token_length,
    )


def _wire_index_document(document: Mapping[str, Any]):
    from agent.rag.models import IndexDocument, Scope

    metadata = dict(document.get("metadata") or {})
    scope = Scope(
        owner_user_id="", platform=str(document.get("platform") or ""),
        bot_id=str(document.get("bot_id") or ""), group_id=str(document.get("group_id") or ""),
        scope_type=str(document.get("scope_type") or "owner"), scope_id=str(document.get("scope_id") or ""),
    )
    return IndexDocument(
        document_id=str(document.get("id") or ""), source_type=str(document.get("source_type") or ""),
        source_id=str(document.get("source_id") or metadata.get("source_id") or document.get("id") or ""),
        # TS rank-candidates 将 rankingText(document) 直接交给 IDF rescore；
        # 此处把它作为 canonical content，避免 IndexDocument 再拼接标题/摘要。
        scope=scope, title="", summary="",
        content=str(document.get("ranking_text") or document.get("text") or ""),
        version=str(document.get("document_version") or ""),
        chunk_index=int(document.get("chunk_index") or 0), parent_document_id=document.get("parent_id"),
        updated_at=document.get("updated_at"), metadata=metadata,
    )


def _rank_sort_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
    candidate = item["candidate"]
    document = candidate.get("document") or {}
    source = str(candidate.get("source_type") or "")
    return (
        -item["value"], -item["rank_score"], -item["fused"],
        _SOURCE_PRIORITY.get(source, 100),
        reverse_locale_sort_key(str(document.get("updated_at") or "")),
        locale_sort_key(str(document.get("document_version") or "")),
        locale_sort_key(str(document.get("id") or "")),
    )


def _compact(value: str) -> str:
    return _JS_WS_RE.sub("", value).lower()


def _js_trim(value: str) -> str:
    return _JS_TRIM_END.sub("", _JS_TRIM_START.sub("", value))


def _digest(value: str) -> str:
    # Node Buffer/crypto 把孤立 UTF-16 surrogate 编码为 U+FFFD。
    js_text = value.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="replace")
    return hashlib.sha256(js_text.encode("utf-8")).hexdigest()


def _content_hashes(document: Mapping[str, Any]) -> set[str]:
    values = (document.get("content"), document.get("text"))
    hashes: set[str] = set()
    for value in values:
        text = _js_trim(str(value or ""))
        if text:
            hashes.add(_digest(text))
            hashes.add(_digest(_JS_WS_RE.sub("", text)))
    return hashes


def _citation(document: Mapping[str, Any]) -> dict[str, Any]:
    metadata = document.get("metadata") or {}
    parent = document.get("parent_id")
    doc_id = str(document.get("id") or "")
    version = str(document.get("document_version") or "")
    citation = {
        "source_type": str(document.get("source_type") or ""),
        "source_id": str(metadata.get("source_id") or parent or doc_id),
        "title": str(document.get("title") or "未命名来源"),
        "chunk_id": f"{parent or doc_id}:{version}:{int(document.get('chunk_index') or 0)}",
        "version": version,
    }
    if document.get("updated_at"):
        citation["updated_at"] = document["updated_at"]
    return citation


def _select(
    scored: Sequence[Mapping[str, Any]],
    candidates: Sequence[Mapping[str, Any]], options: _SelectionOptions,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    ordered = sorted(
        scored,
        key=lambda item: (-item["rank_score"], locale_sort_key(str(item["candidate"].get("id") or ""))),
    )
    diversity_limited = options.mode != "top_k"
    citations_by_content = _citations_by_content(candidates)
    state = _SelectionState()
    for item in ordered:
        if _consider_candidate(item, state, options, diversity_limited, citations_by_content) == "budget":
            break
    return state.selected, {
        "candidate_count": len(ordered), "accepted_count": len(state.selected),
        "rejected_duplicate": state.rejected_duplicate, "rejected_parent": state.rejected_parent,
        "rejected_source": state.rejected_source, "rejected_similarity": state.rejected_similarity,
        "output_chars": state.output_chars,
    }


def _citations_by_content(candidates: Sequence[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    citations: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        document = candidate.get("document") or {}
        key = _digest(_compact(str(document.get("text") or "")))
        citation = _citation(document)
        if citation not in citations[key]:
            citations[key].append(citation)
    return citations


def _consider_candidate(item, state, options, diversity_limited, citations_by_content) -> str:
    candidate = item["candidate"]
    document = candidate.get("document") or {}
    raw_text = str(document.get("context_text") or document.get("text") or "")
    text = _js_trim(raw_text)
    primary_text = _js_trim(str(document.get("text") or ""))
    if not text:
        return "skip"
    content_hash = _digest(_compact(primary_text))
    if content_hash in state.hashes:
        state.rejected_duplicate += 1
        return "skip"
    parent = str(document.get("parent_id") or document.get("id") or "")
    source = str(document.get("source_type") or "")
    tokens = set(tokenize_raw(str(document.get("text") or "")))
    rejected = _diversity_rejection(
        diversity_limited, parent, source, tokens, state.parent_counts,
        state.source_counts, state.token_sets, options,
    )
    if rejected:
        setattr(state, f"rejected_{rejected}", getattr(state, f"rejected_{rejected}") + 1)
        return "skip"
    remaining = options.max_chars - state.output_chars
    if remaining <= 0:
        return "budget"
    # TS 的 maxChars、slice 和 string.length 按 UTF-16 码元计数；chunk 投影
    # 则按 Unicode 码点，二者契约不同。截断可以产生孤立代理项，需用
    # surrogatepass 保留与 JS slice 相同的字符串边界。
    selected_text = _js_slice(text, remaining) if _js_length(text) > remaining else raw_text
    if _js_length(text) > remaining:
        selected_text = _JS_TRIM_END.sub("", selected_text)
    # TS 先保留 `context_text: ""`，结果映射时再按 `context_text || text`
    # 回退到原文；小数预算不足 1 个 UTF-16 单元时 slice 会为空但候选仍入选。
    output_text = selected_text or str(document.get("text") or "")
    citation = _citation(document)
    state.selected.append(_rank_result(candidate, document, output_text, item, citation, citations_by_content))
    state.hashes.add(content_hash)
    state.token_sets.append(tokens)
    state.parent_counts[parent] += 1
    state.source_counts[source] += 1
    state.output_chars += _js_length(output_text)
    return "budget" if len(state.selected) >= options.limit else "added"


def _js_length(value: str) -> int:
    """返回 JavaScript String.length 对应的 UTF-16 code unit 数。"""
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _js_slice(value: str, end: int) -> str:
    """实现 ``value.slice(0, end)`` 的 UTF-16 code unit 边界。"""
    encoded = value.encode("utf-16-le", errors="surrogatepass")
    return encoded[:max(0, int(end)) * 2].decode("utf-16-le", errors="surrogatepass")


def _diversity_rejection(
    enabled: bool, parent: str, source: str, tokens: set[str],
    parent_counts: Counter[str], source_counts: Counter[str],
    token_sets: Sequence[set[str]], options: _SelectionOptions,
) -> str | None:
    if not enabled:
        return None
    if parent_counts[parent] >= options.max_per_parent:
        return "parent"
    if source_counts[source] >= options.max_per_source:
        return "source"
    if any(_jaccard(tokens, previous) >= 0.85 for previous in token_sets):
        return "similarity"
    return None


def _rank_result(candidate, document, text, item, citation, citations_by_content):
    primary_text = _js_trim(str(document.get("text") or ""))
    result = {
        "id": str(candidate.get("id") or ""), "text": text,
        "confidence": item["value"], "source_quality": item["source_quality"],
        "query_match": item["match"], "normalized_score": item["normalized_score"],
        "fused_score": item["fused"], "rank_score": item["rank_score"],
        "citation": citation,
        "citations": citations_by_content.get(_digest(_compact(primary_text)), [citation]),
    }
    if item["semantic_norm"] is not None:
        result["semantic_norm"] = item["semantic_norm"]
    rescore = item["rescore"]
    if rescore:
        result["query_idf_baseline"] = rescore["query_idf_baseline"]
        result["query_idf_terms"] = rescore["query_idf_terms"]
        result["rank_contributions"] = [
            {"term": row["term"], "idf": row["idf"], "query_weight": row["query_weight"],
             "term_frequency": row["term_frequency"], "weighted": row["weighted"], "nonlinear": row["nonlinear"]}
            for row in rescore["contributions"]
        ]
    return result


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)
