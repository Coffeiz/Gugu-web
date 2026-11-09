"""agent/tools/search.py 单元补测（CRAP 治理 P1）。

覆盖：相似图搜索的图片解析守卫、百度通路配置与配额、deep_research 的凭据和配额。
"""
import base64
import io
from types import SimpleNamespace

import pytest

from agent.tools import search as search_mod


def _png_bytes():
    """返回最小有效 PNG，供相似图输入路径验证真实图片解析。"""
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )


def _settings(**search_overrides):
    search = SimpleNamespace(
        max_results=5, baidu_qianfan_api_key="key-1", similar_image_provider="baidu_qianfan",
        similar_image_default_count=3, similar_image_limit_daily=5, similar_image_timeout_seconds=10,
        deep_research_provider="tavily", tavily_api_key="tv-key",
        deep_research_baidu_api_key="", deep_research_you_api_key="",
    )
    for key, value in search_overrides.items():
        setattr(search, key, value)
    return SimpleNamespace(search=search, quota=SimpleNamespace(default_search_limit_daily=10))


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


# ── _similar_image_search：配置守卫、配额与记录 ──────────────────────────

async def test_similar_image_search_guards_and_happy(db, user_a, monkeypatch):
    monkeypatch.setattr(search_mod, "get_settings",
                        lambda: _settings(similar_image_provider="disabled"))
    assert "尚未配置或未启用" in (await search_mod._similar_image_search(
        db, user_a.id, {"attach_id": "a"}))["error"]

    monkeypatch.setattr(search_mod, "get_settings",
                        lambda: _settings(baidu_qianfan_api_key=""))
    assert "尚未配置或未启用" in (await search_mod._similar_image_search(
        db, user_a.id, {"attach_id": "a"}))["error"]

    monkeypatch.setattr(search_mod, "get_settings", lambda: _settings())
    assert "max_results 必须是" in (await search_mod._similar_image_search(
        db, user_a.id, {"attach_id": "a", "max_results": "abc"}))["error"]

    monkeypatch.setattr(search_mod, "get_user_daily_search_limit", async_none_limit)
    monkeypatch.setattr(search_mod, "count_similar_image_usage", async_hit(99))
    assert "已用完" in (await search_mod._similar_image_search(
        db, user_a.id, {"attach_id": "a"}))["error"]

    recorded = []
    monkeypatch.setattr(search_mod, "count_similar_image_usage", async_hit(0))
    async def fake_record_image(db, uid):
        recorded.append(1)

    monkeypatch.setattr(search_mod, "record_similar_image_usage", fake_record_image)
    monkeypatch.setattr(search_mod, "_resolve_similar_image", _async((b"img", None)))
    monkeypatch.setattr(search_mod, "_call_baidu_similar_image",
                        _async({"results": [{"title": "相似"}]}))
    result = await search_mod._similar_image_search(db, user_a.id, {"attach_id": "a"})
    assert result["results"] == [{"title": "相似"}] and "note" not in result
    assert recorded == [1]

    monkeypatch.setattr(search_mod, "_call_baidu_similar_image", _async({"results": []}))
    result = await search_mod._similar_image_search(db, user_a.id, {"attach_id": "a"})
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
