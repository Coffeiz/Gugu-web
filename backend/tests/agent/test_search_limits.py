"""搜索结果边界保护模型上下文，并在超限时停止读取上游。"""
import json

import httpx

from agent.providers.search_http import read_search_response
from agent.providers.search_limits import (
    MAX_ARRAY_ITEMS, MAX_RESPONSE_BYTES, MAX_RESULT_BYTES, MAX_TEXT_CHARS,
    limit_search_result,
)


def test_small_native_result_is_unchanged():
    original = {"results": [{"title": "资料", "url": "https://example.com/page", "content": "正文"}], "usage": {"tokens": 2}}
    assert limit_search_result(original) == original


def test_unicode_result_has_total_text_and_item_limits_without_mutating_input():
    original = {"results": [{"content": '汉字\\"' * 10000, "url": "https://example.com/page"} for _ in range(50)]}
    result = limit_search_result(original)
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= MAX_RESULT_BYTES
    assert len(result["results"]) <= MAX_ARRAY_ITEMS
    assert all(len(item["content"]) <= MAX_TEXT_CHARS for item in result["results"])
    assert all(item.get("url", "https://example.com/page") == "https://example.com/page" for item in result["results"])
    assert result["_gugu_search_limits"]["truncated"] is True
    assert len(original["results"]) == 50


def test_array_limit_is_explicit():
    result = limit_search_result({"results": list(range(100))})
    assert result["results"] == list(range(MAX_ARRAY_ITEMS))
    assert result["_gugu_search_limits"]["truncated"]


class CountingStream(httpx.AsyncByteStream):
    def __init__(self):
        self.reads = 0
        self.closed = False

    async def __aiter__(self):
        for _ in range(100):
            self.reads += 1
            yield b"x" * (MAX_RESPONSE_BYTES // 2)

    async def aclose(self):
        self.closed = True


async def test_unknown_length_response_stops_early_and_closes():
    stream = CountingStream()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=stream))) as client:
        async with client.stream("GET", "https://example.com") as response:
            result = await read_search_response(response, label="测试搜索")
    assert "超过大小限制" in result["error"]
    assert stream.reads == 3
    assert stream.closed


async def test_upstream_errors_do_not_expose_body():
    response = httpx.Response(200, json={"error": "秘密上游响应"})
    result = await read_search_response(response, label="测试搜索")
    assert "error" in result
    assert "秘密" not in str(result)


async def test_compressed_response_is_limited_after_decompression():
    import gzip

    body = gzip.compress(b'"' + b'x' * MAX_RESPONSE_BYTES + b'"')
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"Content-Encoding": "gzip", "Content-Length": str(len(body))}, content=body))) as client:
        async with client.stream("GET", "https://example.com") as response:
            result = await read_search_response(response, label="测试搜索")
    assert "超过大小限制" in result["error"]


def test_link_is_kept_whole_or_omitted_and_status_survives_large_body():
    url = "https://example.com/" + "x" * MAX_RESULT_BYTES
    result = limit_search_result({"content": "正文" * 50000, "url": url, "base_resp": {"status_code": 1001}})
    assert "url" not in result
    assert result["base_resp"]["status_code"] == 1001
    assert result["_gugu_search_limits"]["truncated"]
