"""深度研究 Provider 的请求与统一结果回归。"""

from contextlib import asynccontextmanager

import httpx
import pytest

from agent.tools import deep_research


def _mock_safe_post(monkeypatch, payload):
    requests = []

    @asynccontextmanager
    async def stream(_self, url, *, timeout, headers=None, post_json=None):
        requests.append((url, timeout, headers, post_json))
        request = httpx.Request("POST", url, json=post_json, headers=headers)
        yield httpx.Response(200, json=payload, request=request)

    from app.core.safe_egress import SafeEgressClient

    monkeypatch.setattr(SafeEgressClient, "stream", stream)
    return requests


@pytest.mark.asyncio
async def test_tavily_is_normalized(monkeypatch):
    requests = _mock_safe_post(monkeypatch, {"answer": "答案", "results": [{"title": "来源", "url": "https://example.test", "content": "正文"}]})

    result = await deep_research.run("tavily", "问题", "key", max_results=5, depth="basic")

    assert result["answer"] == "答案"
    assert result["results"][0]["url"] == "https://example.test"
    assert requests[0][0] == "https://api.tavily.com/search"


@pytest.mark.asyncio
async def test_you_uses_research_api(monkeypatch):
    requests = _mock_safe_post(monkeypatch, {"output": {"content": "研究结论", "sources": [{"title": "来源", "url": "https://example.test", "snippets": ["摘录"]}]}})

    result = await deep_research.run("you", "问题", "key", max_results=5, depth="advanced")

    assert result["answer"] == "研究结论"
    assert result["results"][0]["content"] == "摘录"
    assert requests[0][0] == "https://api.you.com/v1/research"
    assert requests[0][3]["research_effort"] == "deep"


@pytest.mark.asyncio
async def test_baidu_uses_ordinary_search(monkeypatch):
    requests = _mock_safe_post(monkeypatch, {"request_id": "req", "references": [
        {"id": 1, "title": "来源", "url": "https://example.test", "content": "网页片段"},
    ]})

    result = await deep_research.run("baidu", "普通搜索问题", "key", max_results=5, depth="basic")

    assert result["answer"] is None
    assert result["results"][0]["content"] == "网页片段"
    assert requests[0][0] == "https://qianfan.baidubce.com/v2/ai_search/web_search"
    assert requests[0][2]["X-Appbuilder-Authorization"] == "Bearer key"
    assert requests[0][3]["search_source"] == "baidu_search_v2"
    assert requests[0][3]["resource_type_filter"] == [{"type": "web", "top_k": 5}]
