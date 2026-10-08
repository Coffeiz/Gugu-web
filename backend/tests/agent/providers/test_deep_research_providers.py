"""深度研究 Provider 的请求与统一结果回归。"""

import pytest

from agent.tools import deep_research


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class _Client:
    def __init__(self, response):
        self.response = response
        self.request = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, **kwargs):
        self.request = (url, kwargs)
        return self.response


@pytest.mark.asyncio
async def test_tavily_is_normalized(monkeypatch):
    client = _Client(_Response({"answer": "答案", "results": [{"title": "来源", "url": "https://example.test", "content": "正文"}]}))
    monkeypatch.setattr(deep_research.httpx, "AsyncClient", lambda **kwargs: client)

    result = await deep_research.run("tavily", "问题", "key", max_results=5, depth="basic")

    assert result["answer"] == "答案"
    assert result["results"][0]["url"] == "https://example.test"
    assert client.request[0] == "https://api.tavily.com/search"


@pytest.mark.asyncio
async def test_you_uses_research_api(monkeypatch):
    client = _Client(_Response({"output": {"content": "研究结论", "sources": [{"title": "来源", "url": "https://example.test", "snippets": ["摘录"]}]}}))
    monkeypatch.setattr(deep_research.httpx, "AsyncClient", lambda **kwargs: client)

    result = await deep_research.run("you", "问题", "key", max_results=5, depth="advanced")

    assert result["answer"] == "研究结论"
    assert result["results"][0]["content"] == "摘录"
    assert client.request[0] == "https://api.you.com/v1/research"
    assert client.request[1]["json"]["research_effort"] == "deep"


@pytest.mark.asyncio
async def test_baidu_uses_ordinary_search(monkeypatch):
    client = _Client(_Response({"request_id": "req", "references": [
        {"id": 1, "title": "来源", "url": "https://example.test", "content": "网页片段"},
    ]}))
    monkeypatch.setattr(deep_research.httpx, "AsyncClient", lambda **kwargs: client)

    result = await deep_research.run("baidu", "普通搜索问题", "key", max_results=5, depth="basic")

    assert result["answer"] is None
    assert result["results"][0]["content"] == "网页片段"
    assert client.request[0] == "https://qianfan.baidubce.com/v2/ai_search/web_search"
    assert client.request[1]["headers"]["X-Appbuilder-Authorization"] == "Bearer key"
    assert client.request[1]["json"]["search_source"] == "baidu_search_v2"
    assert client.request[1]["json"]["resource_type_filter"] == [{"type": "web", "top_k": 5}]
