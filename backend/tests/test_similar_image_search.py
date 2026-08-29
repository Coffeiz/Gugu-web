"""相似图搜索 P1-P3 回归：输入校验、百度响应归一化和配置边界。"""

import base64
from types import SimpleNamespace

import httpx
import pytest

import agent.tools.search as search_tools


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class _Response:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, response):
        self.response = response
        self.request = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, headers=None, json=None):
        self.request = {"url": url, "headers": headers, "json": json}
        return self.response


@pytest.mark.asyncio
async def test_resolve_network_image_validates_and_returns_bytes(monkeypatch):
    async def fake_download(*args, **kwargs):
        return {"data": PNG_1X1, "ext": "png", "mime": "image/png"}

    monkeypatch.setattr("agent.tools.files._send_file_from_url", fake_download)

    raw, error = await search_tools._resolve_similar_image(
        "user-a", {"image_url": "https://images.example.test/a.png"}
    )

    assert raw == PNG_1X1
    assert error is None


@pytest.mark.asyncio
async def test_resolve_similar_image_rejects_unsupported_network_format(monkeypatch):
    async def fake_download(*args, **kwargs):
        return {"data": b"gif", "ext": "gif", "mime": "image/gif"}

    monkeypatch.setattr("agent.tools.files._send_file_from_url", fake_download)

    raw, error = await search_tools._resolve_similar_image(
        "user-a", {"image_url": "https://images.example.test/a.gif"}
    )

    assert raw is None
    assert error == "网络图片不是支持的 JPG 或 PNG 格式"


@pytest.mark.asyncio
async def test_baidu_provider_sends_base64_and_normalizes_results(monkeypatch):
    client = _Client(_Response({
        "requestId": "req-1",
        "res_data": {"res_items": [{
            "title": "相似结果",
            "site_name": "示例站点",
            "fromurl": "https://example.test/source",
            "objurl": "https://example.test/image.png",
            "detail_page": "https://example.test/detail",
            "sim_level": 0.91,
            "width": 100,
            "height": 80,
        }]},
    }))
    monkeypatch.setattr(search_tools.httpx, "AsyncClient", lambda **kwargs: client)

    result = await search_tools._call_baidu_similar_image(PNG_1X1, "secret-key", 1, 20)

    assert result["count"] == 1
    assert result["results"][0]["detail_url"] == "https://example.test/detail"
    assert client.request["headers"] == {
        "Authorization": "Bearer secret-key",
        "Content-Type": "application/json",
    }
    assert client.request["json"]["image"] == base64.b64encode(PNG_1X1).decode("ascii")
    assert "secret-key" not in str(result)


@pytest.mark.asyncio
async def test_baidu_provider_rejects_non_ascii_api_key_before_request(monkeypatch):
    called = False

    def unexpected_client(**kwargs):
        nonlocal called
        called = True
        return _Client(_Response({}))

    monkeypatch.setattr(search_tools.httpx, "AsyncClient", unexpected_client)

    result = await search_tools._call_baidu_similar_image(PNG_1X1, "百度密钥", 1, 20)

    assert result == {
        "error": "百度相似图搜索 API Key 格式无效，请使用服务提供的 ASCII API Key",
        "error_code": "invalid_api_key",
    }
    assert called is False


@pytest.mark.asyncio
async def test_baidu_provider_reads_official_result_wrapper(monkeypatch):
    client = _Client(_Response({
        "code": "0",
        "requestId": "req-wrapped",
        "result": {
            "res_data": {
                "res_items": [{
                    "title": "官方结构结果",
                    "objurl": "https://example.test/wrapped.png",
                    "result_page": "https://example.test/wrapped",
                    "sim_level": 3,
                }],
            },
        },
    }))
    monkeypatch.setattr(search_tools.httpx, "AsyncClient", lambda **kwargs: client)

    result = await search_tools._call_baidu_similar_image(PNG_1X1, "secret-key", 1, 20)

    assert result["request_id"] == "req-wrapped"
    assert result["count"] == 1
    assert result["results"][0]["image_url"] == "https://example.test/wrapped.png"
    assert client.request["headers"]["Content-Type"] == "application/json"


@pytest.mark.asyncio
async def test_baidu_provider_classifies_auth_failure(monkeypatch):
    response = _Response({})
    response.status_code = 401
    client = _Client(response)
    monkeypatch.setattr(search_tools.httpx, "AsyncClient", lambda **kwargs: client)

    result = await search_tools._call_baidu_similar_image(PNG_1X1, "bad-key", 1, 20)

    assert result["error_code"] == "upstream_auth"
    assert "bad-key" not in str(result)


def test_image_search_is_the_only_registered_image_search_tool():
    from agent.tools.base import registry

    assert registry.get("image_search") is not None
    assert registry.get("search_similar_images") is None


@pytest.mark.asyncio
async def test_image_search_dispatches_reverse_image_mode(monkeypatch):
    async def fake_reverse_search(db, user_id, args):
        return {"mode": "image", "max_results": args["max_results"]}

    monkeypatch.setattr(search_tools, "_image_search_by_image", fake_reverse_search)

    result = await search_tools._image_search(None, "user-a", {
        "mode": "image",
        "attach_id": "attach-1",
        "max_results": 7,
    })

    assert result == {"mode": "image", "max_results": 7}


@pytest.mark.asyncio
async def test_image_search_infers_legacy_reverse_image_mode(monkeypatch):
    async def fake_reverse_search(db, user_id, args):
        return {"mode": "image", "attach_id": args["attach_id"]}

    monkeypatch.setattr(search_tools, "_image_search_by_image", fake_reverse_search)

    result = await search_tools._image_search(None, "user-a", {"attach_id": "attach-1"})

    assert result == {"mode": "image", "attach_id": "attach-1"}


@pytest.mark.asyncio
async def test_image_search_rejects_mode_without_required_input():
    assert await search_tools._image_search(None, "user-a", {"mode": "text"}) == {
        "error": "mode=text 时需要提供搜索关键词 query"
    }
    assert await search_tools._image_search(None, "user-a", {"mode": "image"}) == {
        "error": "mode=image 时需要提供 attach_id 或 image_url"
    }


def test_image_search_schema_uses_flat_compatible_input():
    from agent.tools.base import registry

    schema = registry.get("image_search").input_schema
    assert "oneOf" not in schema
    assert schema["properties"]["mode"]["enum"] == ["text", "image"]
    assert "query" in schema["properties"]
    assert "attach_id" in schema["properties"]
    assert "image_url" in schema["properties"]
    assert schema.get("required") is None


def test_image_search_accepts_numeric_string_result_count_after_normalization():
    from agent.tools.base import _coerce_int_ids, build_validator, validate_input, registry

    args = {"mode": "image", "attach_id": "attach-1", "max_results": "5"}
    _coerce_int_ids(args)

    assert args["max_results"] == 5
    assert validate_input(
        build_validator(registry.get("image_search").input_schema), args
    ) == []


def test_similar_image_default_count_is_fifteen():
    from app.core.config import SearchSettings

    assert SearchSettings().similar_image_default_count == 15
