"""外部研究/搜索 Provider 适配器。

三家上游统一返回 query/answer/results，工具层不感知各家的鉴权和响应格式。
百度使用普通百度搜索接口，只返回检索引用，不调用深度研究 Agent。
"""
from __future__ import annotations

from typing import Any

import httpx
from app.core.credentials import normalize_ascii_api_key
from app.core.safe_egress import SafeEgressClient


async def _post_json(endpoint: str, *, headers: dict[str, str], payload: dict, timeout: httpx.Timeout) -> dict:
    async with SafeEgressClient().stream(
        endpoint, timeout=timeout, headers=headers, post_json=payload,
    ) as response:
        response.raise_for_status()
        await response.aread()
        data = response.json()
    if not isinstance(data, dict):
        raise DeepResearchError("研究服务返回了无法识别的数据")
    return data


class DeepResearchError(RuntimeError):
    pass


def _results(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "title": item.get("title"),
            "url": item.get("url"),
            "content": item.get("content") or item.get("description") or "\n".join(item.get("snippets") or []),
        }
        for item in items
        if isinstance(item, dict) and (item.get("url") or item.get("title"))
    ]


async def tavily(query: str, key: str, max_results: int, depth: str) -> dict:
    key = normalize_ascii_api_key(key, label="Tavily API Key")
    data = await _post_json(
        "https://api.tavily.com/search", headers={"Content-Type": "application/json"},
        payload={"api_key": key, "query": query, "max_results": max_results,
                 "search_depth": depth, "include_answer": True},
        timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
    )
    return {"query": query, "answer": data.get("answer"), "results": _results(data.get("results") or [])}


async def you(query: str, key: str, max_results: int, depth: str) -> dict:
    key = normalize_ascii_api_key(key, label="You.com API Key")
    effort = {"basic": "lite", "advanced": "deep"}.get(depth, "standard")
    data = await _post_json(
        "https://api.you.com/v1/research", headers={"X-API-Key": key, "Content-Type": "application/json"},
        payload={"input": query, "research_effort": effort},
        timeout=httpx.Timeout(connect=10, read=90, write=10, pool=5),
    )
    output = data.get("output") or {}
    sources = output.get("sources") or []
    return {"query": query, "answer": output.get("content"), "results": _results(sources[:max_results])}


async def baidu(query: str, key: str, max_results: int) -> dict:
    key = normalize_ascii_api_key(key, label="百度深度研究 API Key")
    top_k = min(max(int(max_results or 1), 1), 50)
    payload = {
        "messages": [{"content": query[:72], "role": "user"}],
        "search_source": "baidu_search_v2",
        "resource_type_filter": [{"type": "web", "top_k": top_k}],
    }
    data = await _post_json(
        "https://qianfan.baidubce.com/v2/ai_search/web_search",
        headers={"X-Appbuilder-Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        payload=payload,
        timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
    )
    return {"query": query, "answer": None, "results": _results(data.get("references") or [])[:top_k]}


async def run(provider: str, query: str, key: str, *, max_results: int, depth: str) -> dict:
    if provider == "tavily":
        return await tavily(query, key, max_results, depth)
    if provider == "you":
        return await you(query, key, max_results, depth)
    if provider == "baidu":
        return await baidu(query, key, max_results)
    raise DeepResearchError(f"不支持的深度研究 Provider：{provider}")
