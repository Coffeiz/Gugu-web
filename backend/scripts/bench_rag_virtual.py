"""虚拟大数据集 RAG 压测。

默认只为每种查询生成一个真实 query embedding，文档向量使用固定随机种子构造，
用于压测大量候选下的本地 cosine 排序和上下文拼装，不会批量消耗 Embedding 配额。
用 ``--embed-docs`` 可额外为前 N 条虚拟文档生成真实向量，检查索引写入链路。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import random
import time
from dataclasses import dataclass
from math import log
from pathlib import Path

from agent.context.provider_runner import complete_json
from agent.memory.embedding import cosine, embed_multimodal, model_tag
from app.core.config import get_settings

_SOURCES = ("project", "note", "memory", "file", "event")
_TOPICS = (
    "文件系统重构",
    "拖拽动画",
    "项目面板",
    "知识召回",
    "群聊记忆",
    "代码编辑器",
    "日程管理",
    "图片资料",
    "普通工作记录",
    "家庭与生活记录",
)
_NOISE_TOPICS = (
    "旅行计划和酒店预订",
    "家庭晚餐菜单",
    "天气和日程提醒",
    "音乐播放列表",
    "健身记录和睡眠",
    "电影观后感",
    "购物清单和快递",
    "英语学习笔记",
)
_INTENT_SYSTEM = (
    "你是知识召回前置路由器。只做意图识别，不回答用户问题。"
    '严格输出 JSON：{"intent":"search_context|action|chat|unknown",'
    '"sources":["project|note|memory|file|event"],"keywords":["短词"],'
    '"need_current":true,"scope":"user|project|conversation|global"}。'
    "需要查找已有内容时用 search_context，明确要执行操作时用 action，普通聊天用 chat。"
)
_RERANK_SYSTEM = (
    "你是检索结果排序器，只负责按用户查询的相关性排序候选文档。"
    '严格输出 JSON：{"ordered_keys":["候选 key"]}。'
    "只能使用候选列表中已有的 key，不要补充、删除或解释。"
)
_DEFAULT_CACHE = Path(__file__).with_name(".bench_rag_embeddings.json")


@dataclass
class VirtualDocument:
    key: str
    source: str
    text: str
    vector: list[float]
    relevant: bool


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="测试真实 LLM/Embedding + 虚拟大规模 RAG")
    parser.add_argument("--docs", type=int, default=10000, help="虚拟文档数量")
    parser.add_argument("--top-k", type=int, default=100, help="返回候选数量")
    parser.add_argument("--embed-docs", type=int, default=0, help="额外真实生成前 N 条文档向量")
    parser.add_argument(
        "--cache",
        type=Path,
        default=_DEFAULT_CACHE,
        help="真实文档向量 JSON 缓存路径，默认保存在本脚本旁边",
    )
    parser.add_argument("--no-cache", action="store_true", help="不读取或写入向量缓存")
    parser.add_argument("--embed-delay", type=float, default=0.25, help="生成文档向量之间的等待秒数")
    parser.add_argument(
        "--rerank-models",
        default="",
        help="逗号分隔的预设匹配词，例如 deepseek,minimax；为空则不执行 LLM 重排",
    )
    parser.add_argument("--seed", type=int, default=20260805, help="随机数据种子")
    parser.add_argument("--relevant-every", type=int, default=50, help="每多少条虚拟数据开始一个相关窗口")
    parser.add_argument("--relevant-per-window", type=int, default=3, help="每个相关窗口包含多少条相关数据")
    parser.add_argument(
        "--query",
        default="找一下文件系统重构项目和拖拽动画相关的记录",
        help="测试查询",
    )
    return parser.parse_args()


def _random_unit_vector(rng: random.Random, dimensions: int) -> list[float]:
    values = [rng.uniform(-1.0, 1.0) for _ in range(dimensions)]
    length = sum(value * value for value in values) ** 0.5 or 1.0
    return [value / length for value in values]


def _make_documents(
    count: int,
    dimensions: int,
    seed: int,
    relevant_every: int,
    relevant_per_window: int,
) -> list[VirtualDocument]:
    rng = random.Random(seed)
    documents = []
    for index in range(count):
        source = _SOURCES[index % len(_SOURCES)]
        relevant = index % max(relevant_every, 1) < max(relevant_per_window, 0)
        topic = _TOPICS[index % 8] if relevant else _NOISE_TOPICS[index % len(_NOISE_TOPICS)]
        documents.append(
            VirtualDocument(
                key=f"{source}-{index}",
                source=source,
                text=f"{source}资料 {index}：{topic}。这是用于 RAG 压测的虚拟内容。",
                vector=_random_unit_vector(rng, dimensions),
                relevant=relevant,
            )
        )
    return documents


def _document_fingerprint(document: VirtualDocument) -> str:
    return hashlib.sha256(document.text.encode("utf-8")).hexdigest()


def _load_vector_cache(path: Path, expected_model: str, expected_dimensions: int) -> dict[str, list[float]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("model_tag") != expected_model or payload.get("dimensions") != expected_dimensions:
            print(json.dumps({"event": "embedding-cache-invalid", "reason": "model_or_dimensions_changed"}, ensure_ascii=False))
            return {}
        vectors = {}
        for key, item in payload.get("vectors", {}).items():
            if isinstance(item, dict) and isinstance(item.get("vector"), list):
                vectors[key] = item["vector"]
        return vectors
    except (OSError, json.JSONDecodeError, TypeError):
        print(json.dumps({"event": "embedding-cache-invalid", "reason": "unreadable"}, ensure_ascii=False))
        return {}


def _save_vector_cache(path: Path, model_tag: str, dimensions: int, documents: list[VirtualDocument]) -> None:
    payload = {
        "version": 1,
        "model_tag": model_tag,
        "dimensions": dimensions,
        "vectors": {
            document.key: {"text_sha256": _document_fingerprint(document), "vector": document.vector}
            for document in documents
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


async def _real_document_vectors(
    documents: list[VirtualDocument],
    limit: int,
    cache: dict[str, list[float]],
    cache_path: Path | None,
    model_tag: str,
    dimensions: int,
    delay: float,
) -> tuple[int, int]:
    """顺序生成真实索引向量，优先复用缓存，避免把 API 打成并发批量请求。"""
    completed = 0
    cached = 0
    for document in documents:
        vector = cache.get(document.key)
        if vector and len(vector) == dimensions:
            document.vector = vector
            cached += 1

    for document in documents[: max(0, min(limit, len(documents)))]:
        if document.key in cache:
            continue
        vector = await embed_multimodal([{"text": document.text}])
        if vector:
            document.vector = vector
            cache[document.key] = vector
            completed += 1
            if cache_path:
                _save_vector_cache(cache_path, model_tag, dimensions, documents)
        if delay > 0:
            await asyncio.sleep(delay)
    if cache_path and completed:
        _save_vector_cache(cache_path, model_tag, dimensions, documents)
    return completed, cached


def _rank(documents: list[VirtualDocument], query_vector: list[float], top_k: int) -> list[VirtualDocument]:
    scored = [(cosine(query_vector, document.vector), document) for document in documents]
    scored.sort(key=lambda item: item[0], reverse=True)
    return [document for _, document in scored[:top_k]]


def _bigrams(text: str) -> set[str]:
    normalized = "".join(text.lower().split())
    return {normalized[i : i + 2] for i in range(max(0, len(normalized) - 1))}


def _bm25_rank(documents: list[VirtualDocument], query: str, top_k: int) -> list[VirtualDocument]:
    """离线虚拟数据基准的简化词法排序，不属于生产 RAG 实现。"""
    query_terms = _bigrams(query)
    if not query_terms:
        return []
    document_terms = [_bigrams(document.text) for document in documents]
    document_frequency = {
        term: sum(term in terms for terms in document_terms) for term in query_terms
    }
    average_length = sum(len(terms) for terms in document_terms) / max(len(documents), 1)
    ranked = []
    for document, terms in zip(documents, document_terms):
        length = len(terms) or 1
        score = 0.0
        for term in query_terms:
            if term not in terms:
                continue
            df = document_frequency[term]
            idf = log(1 + (len(documents) - df + 0.5) / (df + 0.5))
            tf = 1.0
            score += idf * (tf * 2.2 / (tf + 1.2 * (0.75 + 0.25 * length / average_length)))
        if score:
            ranked.append((score, document))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [document for _, document in ranked[:top_k]]


def _quality(results: list[VirtualDocument], total_relevant: int) -> dict:
    metrics = {}
    for k in (10, 20, 50, 100):
        relevant = sum(item.relevant for item in results[:k])
        returned = min(k, len(results))
        metrics[f"@{k}"] = {
            "relevant": relevant,
            "returned": returned,
            "precision": round(relevant / k, 3),
            "precision_over_returned": round(relevant / max(returned, 1), 3),
            "recall": round(relevant / max(total_relevant, 1), 3),
        }
    return metrics


def _result_details(results: list[VirtualDocument], top_k: int) -> list[dict]:
    return [
        {"key": item.key, "source": item.source, "relevant": item.relevant}
        for item in results[: min(top_k, 20)]
    ]


def _find_model_settings(settings, selector: str):
    """按 provider/model/name/id 找一个预设，只用于本次压测，不改变运行时激活模型。"""
    needle = selector.strip().lower()
    candidates = [settings.ai]
    presets = getattr(getattr(settings, "ai_presets", None), "items", []) or []
    candidates.extend(presets)
    for candidate in candidates:
        haystack = " ".join(
            str(getattr(candidate, field, ""))
            for field in ("provider", "model", "name", "id")
        ).lower()
        if needle in haystack:
            clone = copy.deepcopy(settings)
            clone.ai = copy.deepcopy(candidate)
            return clone
    return None


async def _run_rerank_mode(
    selector: str,
    query: str,
    settings,
    candidates: list[VirtualDocument],
    top_k: int,
) -> dict:
    model_settings = _find_model_settings(settings, selector)
    if model_settings is None:
        return {"mode": "llm_rerank", "model_selector": selector, "error": "model_not_found"}

    candidate_payload = [
        {"key": item.key, "source": item.source, "text": item.text}
        for item in candidates
    ]
    started = time.perf_counter()
    output = await complete_json(
        _RERANK_SYSTEM,
        json.dumps({"query": query, "candidates": candidate_payload}, ensure_ascii=False),
        model_settings,
        max_tokens=max(600, len(candidates) * 35),
        temperature=0.0,
        thinking="disabled",
    )
    rerank_ms = (time.perf_counter() - started) * 1000
    valid_keys = {item.key for item in candidates}
    ordered_keys = output.get("ordered_keys") if isinstance(output, dict) else None
    ordered = []
    seen = set()
    if isinstance(ordered_keys, list):
        by_key = {item.key: item for item in candidates}
        for key in ordered_keys:
            item = by_key.get(str(key))
            if item is not None and item.key not in seen:
                ordered.append(item)
                seen.add(item.key)
    ordered.extend(item for item in candidates if item.key not in seen)
    started = time.perf_counter()
    context = "\n".join(f"[{item.source}] {item.text}" for item in ordered[:top_k])
    inject_ms = (time.perf_counter() - started) * 1000
    return {
        "mode": "llm_rerank",
        "model_selector": selector,
        "model": model_settings.ai.model,
        "provider": model_settings.ai.provider,
        "candidate_count": len(candidates),
        "valid_returned_keys": (
            len({str(key) for key in ordered_keys} & valid_keys)
            if isinstance(ordered_keys, list)
            else 0
        ),
        "quality": _quality(ordered, sum(item.relevant for item in candidates)),
        "top_results": _result_details(ordered, top_k),
        "context_chars": len(context),
        "timing_ms": {
            "llm_rerank": round(rerank_ms, 1),
            "context_inject": round(inject_ms, 1),
            "total": round(rerank_ms + inject_ms, 1),
        },
    }


async def _run_mode(
    mode: str,
    query: str,
    settings,
    documents: list[VirtualDocument],
    top_k: int,
    use_llm: bool,
) -> dict:
    intent = {}
    intent_ms = 0.0
    search_text = query
    if use_llm:
        started = time.perf_counter()
        intent = await complete_json(
            _INTENT_SYSTEM,
            query,
            settings,
            max_tokens=220,
            temperature=0.1,
            thinking="disabled",
        )
        intent_ms = (time.perf_counter() - started) * 1000
        keywords = intent.get("keywords") if isinstance(intent, dict) else None
        if isinstance(keywords, list) and keywords:
            search_text = " ".join(str(keyword) for keyword in keywords)

    started = time.perf_counter()
    query_vector = await embed_multimodal([{"text": search_text}])
    embedding_ms = (time.perf_counter() - started) * 1000
    if not query_vector:
        return {"mode": mode, "error": "query_embedding_failed", "intent": intent}

    started = time.perf_counter()
    results = _rank(documents, query_vector, top_k)
    rank_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    context = "\n".join(f"[{item.source}] {item.text}" for item in results)
    inject_ms = (time.perf_counter() - started) * 1000
    return {
        "mode": mode,
        "intent": intent,
        "query_for_embedding": search_text,
        "hits": len(results),
        "quality": _quality(results, sum(item.relevant for item in documents)),
        "top_results": [
            {"key": item.key, "source": item.source, "relevant": item.relevant}
            for item in results[: min(top_k, 20)]
        ],
        "context_chars": len(context),
        "timing_ms": {
            "llm_intent": round(intent_ms, 1),
            "query_embedding": round(embedding_ms, 1),
            "cosine_top_k": round(rank_ms, 1),
            "context_inject": round(inject_ms, 1),
            "total": round(intent_ms + embedding_ms + rank_ms + inject_ms, 1),
        },
    }


async def _run_bm25_mode(
    mode: str,
    query: str,
    settings,
    documents: list[VirtualDocument],
    top_k: int,
    use_llm: bool,
) -> dict:
    intent = {}
    intent_ms = 0.0
    search_text = query
    if use_llm:
        started = time.perf_counter()
        intent = await complete_json(
            _INTENT_SYSTEM,
            query,
            settings,
            max_tokens=220,
            temperature=0.1,
            thinking="disabled",
        )
        intent_ms = (time.perf_counter() - started) * 1000
        keywords = intent.get("keywords") if isinstance(intent, dict) else None
        if isinstance(keywords, list) and keywords:
            search_text = " ".join(str(keyword) for keyword in keywords)

    started = time.perf_counter()
    results = _bm25_rank(documents, search_text, top_k)
    rank_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    context = "\n".join(f"[{item.source}] {item.text}" for item in results)
    inject_ms = (time.perf_counter() - started) * 1000
    return {
        "mode": mode,
        "intent": intent,
        "query_for_bm25": search_text,
        "hits": len(results),
        "quality": _quality(results, sum(item.relevant for item in documents)),
        "top_results": [
            {"key": item.key, "source": item.source, "relevant": item.relevant}
            for item in results[: min(top_k, 20)]
        ],
        "context_chars": len(context),
        "timing_ms": {
            "llm_intent": round(intent_ms, 1),
            "bm25_top_k": round(rank_ms, 1),
            "context_inject": round(inject_ms, 1),
            "total": round(intent_ms + rank_ms + inject_ms, 1),
        },
    }


async def main() -> None:
    args = _args()
    settings = get_settings()
    probe_vector = await embed_multimodal([{"text": args.query}])
    if not probe_vector:
        raise SystemExit("Embedding 查询失败：请检查 embedding 模型、端点和配额")

    documents = _make_documents(
        args.docs,
        len(probe_vector),
        args.seed,
        args.relevant_every,
        args.relevant_per_window,
    )
    cache_path = None if args.no_cache else args.cache
    current_model_tag = model_tag()
    vector_cache = (
        _load_vector_cache(cache_path, current_model_tag, len(probe_vector))
        if cache_path
        else {}
    )
    real_index_count, cached_index_count = await _real_document_vectors(
        documents,
        args.embed_docs,
        vector_cache,
        cache_path,
        current_model_tag,
        len(probe_vector),
        args.embed_delay,
    )
    real_vector_count = real_index_count + cached_index_count
    print(
        json.dumps(
            {
                "event": "index-ready",
                "docs": len(documents),
                "dimensions": len(probe_vector),
                "model_tag": current_model_tag,
                "cache": str(cache_path) if cache_path else None,
                "generated_vectors": real_index_count,
                "cached_vectors": cached_index_count,
                "real_vectors": real_vector_count,
                "random_vectors": len(documents) - real_vector_count,
                "quality_valid": real_vector_count == len(documents),
                "labeled_relevant": sum(item.relevant for item in documents),
                "top_k": args.top_k,
            },
            ensure_ascii=False,
        )
    )

    for mode, use_llm in (("bm25_without_llm", False), ("bm25_with_llm", True)):
        result = await _run_bm25_mode(mode, args.query, settings, documents, args.top_k, use_llm)
        print(json.dumps(result, ensure_ascii=False))

    if args.rerank_models.strip():
        candidates = _bm25_rank(documents, args.query, args.top_k)
        print(
            json.dumps(
                {
                    "event": "rerank-input",
                    "candidate_count": len(candidates),
                    "candidates": _result_details(candidates, args.top_k),
                },
                ensure_ascii=False,
            )
        )
        for selector in args.rerank_models.split(","):
            result = await _run_rerank_mode(selector, args.query, settings, candidates, args.top_k)
            print(json.dumps(result, ensure_ascii=False))

    for mode, use_llm in (("without_llm", False), ("with_llm", True)):
        result = await _run_mode(mode, args.query, settings, documents, args.top_k, use_llm)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
