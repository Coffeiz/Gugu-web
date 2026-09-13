"""agent/tools/search.py 单元补测（CRAP 治理 P1）。

覆盖：SearXNG 通用/图片搜索的状态与降级路径、相似图搜索的图片解析守卫、
百度通路的配置守卫与配额、deep_research 的凭据/配额/兜底。
httpx 用假客户端（预设响应/异常），配额与凭据模块级打桩，不触真实网络。
"""
import io
from types import SimpleNamespace

import httpx
import pytest

from agent.tools import search as search_mod
from agent.tools.search import _normalize_failure_reason


def _settings(**search_overrides):
    search = SimpleNamespace(
        searxng_url="http://searx", searxng_engines="sogou,quark",
        searxng_image_engines="", max_results=5,
        baidu_qianfan_api_key="key-1", similar_image_provider="baidu_qianfan",
        similar_image_default_count=3, similar_image_limit_daily=5,
        similar_image_timeout_seconds=10,
        deep_research_provider="tavily", tavily_api_key="tv-key",
        deep_research_baidu_api_key="", deep_research_you_api_key="",
    )
    for key, value in search_overrides.items():
        setattr(search, key, value)
    return SimpleNamespace(search=search,
                           quota=SimpleNamespace(default_search_limit_daily=10))


class FakeClient:
    """替身 httpx.AsyncClient：按类属性吐响应或抛异常（图片搜索重试序列用）。"""
    response = None
    raise_first = None
    raise_always = None

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, _url):
        if type(self).raise_always is not None:
            raise type(self).raise_always
        if type(self).raise_first is not None:
            exc, type(self).raise_first = type(self).raise_first, None
            raise exc
        return type(self).response


def _wire_http(monkeypatch, response=None, raise_first=None, raise_always=None):
    FakeClient.response = response
    FakeClient.raise_first = raise_first
    FakeClient.raise_always = raise_always
    monkeypatch.setattr(search_mod.httpx, "AsyncClient", FakeClient)


def _png_bytes(size=(2, 2)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size).save(buf, format="PNG")
    return buf.getvalue()


# ── _normalize_failure_reason：故障归一 ───────────────────────────────────

def test_normalize_failure_reason_tokens():
    assert _normalize_failure_reason(None) == "unknown"
    assert _normalize_failure_reason("  ") == "unknown"
    assert _normalize_failure_reason("Blocked by CAPTCHA") == "captcha"
    assert _normalize_failure_reason("JS challenge required") == "captcha"
    assert _normalize_failure_reason("Too Many Requests") == "rate_limited"
    assert _normalize_failure_reason("engine RateLimit hit (429)") == "rate_limited"
    assert _normalize_failure_reason("account suspended") == "suspended"
    assert _normalize_failure_reason("Read TIMEOUT after 15s") == "timeout"
    assert _normalize_failure_reason("connection refused") == "unavailable"
    assert _normalize_failure_reason("HTTP 502 bad gateway") == "unavailable"
    assert _normalize_failure_reason("weird failure") == "unknown"


# ── _searxng_search：通用搜索状态机 ───────────────────────────────────────

async def test_searxng_search_guards_and_fallback(db, user_a, monkeypatch):
    monkeypatch.setattr(search_mod, "get_settings",
                        lambda: _settings(searxng_url=""))
    assert "尚未配置通用搜索" in (await search_mod._searxng_search(db, user_a.id, {"q": "x"}))["error"]

    monkeypatch.setattr(search_mod, "get_settings", lambda: _settings())
    assert "需要提供搜索关键词" in (await search_mod._searxng_search(db, user_a.id, {}))["error"]

    _wire_http(monkeypatch, response=httpx.Response(403))
    assert "403" in (await search_mod._searxng_search(db, user_a.id, {"query": "x"}))["error"]

    _wire_http(monkeypatch, response=httpx.Response(500))
    assert "HTTP 500" in (await search_mod._searxng_search(db, user_a.id, {"query": "x"}))["error"]

    _wire_http(monkeypatch, response=httpx.Response(200, text="not-json"))
    assert "不是 JSON" in (await search_mod._searxng_search(db, user_a.id, {"query": "x"}))["error"]

    # 网络异常 → 直接切 deep_research 兜底
    _wire_http(monkeypatch, raise_first=httpx.ConnectError("boom"))

    async def fake_deep(db, user_id, args):
        return {"fallback": args["query"]}

    monkeypatch.setattr(search_mod, "_deep_research", fake_deep)
    result = await search_mod._searxng_search(db, user_a.id, {"query": "天气"})
    assert result == {"fallback": "天气"}

    data = {"results": [
        {"title": "结果一", "url": "https://a", "content": "长" * 400},
        {"title": "无正文", "url": "https://b"},
    ]}
    _wire_http(monkeypatch, response=httpx.Response(200, json=data))
    payload = await search_mod._searxng_search(db, user_a.id, {"query": "天气"})
    assert payload["results"][0]["content"] == "长" * 300                # 摘要截断 300
    assert payload["results"][1]["content"] == ""
    assert payload["search_status"]["state"] == "ok"


# ── _searxng_image_search：图片搜索重试与结果整形 ─────────────────────────

async def test_searxng_image_search_retry_and_shaping(db, user_a, monkeypatch):
    monkeypatch.setattr(search_mod, "get_settings", lambda: _settings())
    assert "需要提供搜索关键词" in (await search_mod._searxng_image_search(db, user_a.id, {}))["error"]

    _wire_http(monkeypatch, raise_first=httpx.ConnectError("down"),
               response=httpx.Response(200, json={"results": []}))
    payload = await search_mod._searxng_image_search(db, user_a.id, {"query": "猫"})   # 首挂重试成
    assert payload["results"] == []

    _wire_http(monkeypatch, raise_always=httpx.ConnectError("down"))
    payload = await search_mod._searxng_image_search(db, user_a.id, {"query": "猫"})
    assert "图片搜索暂时失败" in payload["error"]                       # 两次都挂 → 报错

    _wire_http(monkeypatch, response=httpx.Response(200, json={"results": [
        {"title": "有图", "url": "https://page", "img_src": "https://img/1.jpg"},
        {"title": "无图", "url": "https://page2"},                        # 无 img_src 被过滤
        {"title": "缩略图", "url": "https://p3", "img_src": "https://img/3",
         "thumbnail": "https://thumb/3"},
    ]}))
    payload = await search_mod._searxng_image_search(db, user_a.id, {"query": "猫"})
    # result_id 是源顺序索引（含被过滤项），过滤后不重排
    assert [r["result_id"] for r in payload["results"]] == ["image-1", "image-3"]
    assert payload["results"][1]["thumbnail"] == "https://thumb/3"


# ── _resolve_similar_image：图片字节解析守卫 ──────────────────────────────

async def test_resolve_similar_image_guards_and_happy(user_a, monkeypatch):
    from app.core import chat_attach

    raw, error = await search_mod._resolve_similar_image(user_a.id, {})
    assert raw is None and "需要提供" in error

    async def no_meta(*a):
        return None

    monkeypatch.setattr(chat_attach, "get_meta", no_meta)
    _r, error = await search_mod._resolve_similar_image(user_a.id, {"attach_id": "gone"})
    assert "找不到这个图片附件" in error

    async def voice_meta(*a):
        return {"kind": "voice", "ext": "amr"}

    monkeypatch.setattr(chat_attach, "get_meta", voice_meta)
    _r, error = await search_mod._resolve_similar_image(user_a.id, {"attach_id": "a1"})
    assert "不是图片" in error

    async def webp_meta(*a):
        return {"kind": "image", "ext": "webp"}

    monkeypatch.setattr(chat_attach, "get_meta", webp_meta)
    _r, error = await search_mod._resolve_similar_image(user_a.id, {"attach_id": "a1"})
    assert "只支持 JPG 和 PNG" in error

    async def png_meta(*a):
        return {"kind": "image", "ext": "png"}

    monkeypatch.setattr(chat_attach, "get_meta", png_meta)

    async def big_bytes(meta):
        return b"x" * (4 * 1024 * 1024 + 1)

    monkeypatch.setattr(chat_attach, "read_bytes", big_bytes)
    _r, error = await search_mod._resolve_similar_image(user_a.id, {"attach_id": "a1"})
    assert "4MB" in error

    async def junk_bytes(meta):
        return b"junk-not-image"

    monkeypatch.setattr(chat_attach, "read_bytes", junk_bytes)
    _r, error = await search_mod._resolve_similar_image(user_a.id, {"attach_id": "a1"})
    assert "无法解析" in error

    png = _png_bytes()

    async def good_bytes(meta):
        return png

    monkeypatch.setattr(chat_attach, "read_bytes", good_bytes)
    got, error = await search_mod._resolve_similar_image(user_a.id, {"attach_id": "a1"})
    assert error is None and got == png

    # 网络图片路径
    async def fake_from_url(_db, url, _name, *, stage):
        return {"data": png, "ext": "png"}

    monkeypatch.setattr("agent.tools.files._send_file_from_url", fake_from_url)
    got, error = await search_mod._resolve_similar_image(user_a.id, {"image_url": "https://x/a.png"})
    assert error is None and got == png

    async def bad_url(*a, **k):
        return "下载失败文本"

    monkeypatch.setattr("agent.tools.files._send_file_from_url", bad_url)
    _r, error = await search_mod._resolve_similar_image(user_a.id, {"image_url": "https://x/a.png"})
    assert "下载失败" in error


# ── _image_search_by_image：配置守卫、配额与记录 ──────────────────────────

async def test_image_search_by_image_guards_and_happy(db, user_a, monkeypatch):
    monkeypatch.setattr(search_mod, "get_settings",
                        lambda: _settings(similar_image_provider="disabled"))
    assert "尚未配置或未启用" in (await search_mod._image_search_by_image(
        db, user_a.id, {"attach_id": "a"}))["error"]

    monkeypatch.setattr(search_mod, "get_settings",
                        lambda: _settings(baidu_qianfan_api_key=""))
    assert "尚未配置或未启用" in (await search_mod._image_search_by_image(
        db, user_a.id, {"attach_id": "a"}))["error"]

    monkeypatch.setattr(search_mod, "get_settings", lambda: _settings())
    assert "max_results 必须是" in (await search_mod._image_search_by_image(
        db, user_a.id, {"attach_id": "a", "max_results": "abc"}))["error"]

    monkeypatch.setattr(search_mod, "get_user_daily_search_limit", async_none_limit)
    monkeypatch.setattr(search_mod, "count_similar_image_usage", async_hit(99))
    assert "已用完" in (await search_mod._image_search_by_image(
        db, user_a.id, {"attach_id": "a"}))["error"]

    recorded = []
    monkeypatch.setattr(search_mod, "count_similar_image_usage", async_hit(0))
    async def fake_record_image(db, uid):
        recorded.append(1)

    monkeypatch.setattr(search_mod, "record_similar_image_usage", fake_record_image)
    monkeypatch.setattr(search_mod, "_resolve_similar_image", _async((b"img", None)))
    monkeypatch.setattr(search_mod, "_call_baidu_similar_image",
                        _async({"results": [{"title": "相似"}]}))
    result = await search_mod._image_search_by_image(db, user_a.id, {"attach_id": "a"})
    assert result["results"] == [{"title": "相似"}] and "note" not in result
    assert recorded == [1]

    monkeypatch.setattr(search_mod, "_call_baidu_similar_image", _async({"results": []}))
    result = await search_mod._image_search_by_image(db, user_a.id, {"attach_id": "a"})
    assert result["note"] == "没有找到相似结果"


# ── _deep_research：凭据、配额与用量记录 ──────────────────────────────────

async def async_none_limit(db, user_id):
    return None


def async_hit(value):
    """同步工厂：返回 quota 查询的 async 替身（ setattr 需要 async 函数本身）。"""
    async def _inner(db, user_id, *args, **kwargs):
        return value
    return _inner


def _async(value):
    async def _inner(*args, **kwargs):
        return value
    return _inner


async def test_deep_research_guards_quota_and_usage(db, user_a, monkeypatch):
    monkeypatch.setattr(search_mod, "get_settings",
                        lambda: _settings(tavily_api_key="", deep_research_provider="tavily"))
    assert "尚未配置深度研究" in json_error(await search_mod._deep_research(db, user_a.id, {"query": "x"}))

    monkeypatch.setattr(search_mod, "get_settings", lambda: _settings())
    assert "需要提供搜索关键词" in json_error(await search_mod._deep_research(db, user_a.id, {}))

    monkeypatch.setattr(search_mod, "get_user_daily_search_limit", async_hit(1))
    monkeypatch.setattr(search_mod, "count_daily_search_usage", async_hit(1))
    assert "已用完" in json_error(await search_mod._deep_research(db, user_a.id, {"query": "x"}))

    monkeypatch.setattr(search_mod, "get_user_daily_search_limit", async_none_limit)
    monkeypatch.setattr(search_mod, "count_daily_search_usage", async_hit(0))
    recorded = []

    async def fake_record(db, uid, q):
        recorded.append(q)

    monkeypatch.setattr(search_mod, "record_search_usage", fake_record)

    async def fake_run(provider, query, key, *, max_results, depth):
        assert provider == "tavily" and key == "tv-key"
        return {"answer": query}

    monkeypatch.setattr("agent.tools.deep_research.run", fake_run)
    assert await search_mod._deep_research(db, user_a.id, {"query": "量子计算"}) == {"answer": "量子计算"}
    assert recorded == ["量子计算"]                                     # 成功才计用量

    async def boom(*a, **k):
        raise RuntimeError("provider down")

    monkeypatch.setattr("agent.tools.deep_research.run", boom)
    assert "深度研究失败" in json_error(await search_mod._deep_research(db, user_a.id, {"query": "x"}))


def json_error(raw):
    import json
    return json.loads(raw)["error"]
