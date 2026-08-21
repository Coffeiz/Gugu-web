"""SearXNG 空结果/引擎故障语义回归。"""
from types import SimpleNamespace
import logging
import httpx

import agent.tools.search as search_tools


def test_parse_requested_engines_is_config_driven_and_deduplicated():
    assert search_tools._parse_requested_engines("sogou, quark,360search,sogou") == [
        "sogou", "quark", "360search"
    ]
    assert search_tools._parse_requested_engines("") == []


def test_normalize_engine_failures_maps_common_reasons_and_tolerates_shapes():
    failures = search_tools._normalize_engine_failures({
        "unresponsive_engines": [
            ["sogou", "CAPTCHA challenge"],
            ["quark", "Read timeout"],
            {"engine": "360search", "reason": "Too Many Requests (429)"},
            "bing: suspended for access denied",
            ["unknown-engine"],
        ]
    })

    assert failures == [
        {"engine": "sogou", "reason": "captcha"},
        {"engine": "quark", "reason": "timeout"},
        {"engine": "360search", "reason": "rate_limited"},
        {"engine": "bing", "reason": "suspended"},
        {"engine": "unknown-engine", "reason": "unknown"},
    ]
    assert search_tools._normalize_engine_failures({"unresponsive_engines": "unexpected"}) == []
    assert search_tools._normalize_engine_failures({}) == []


def test_search_status_ok_empty_degraded_and_unavailable():
    engines = ["sogou", "quark", "360search"]

    ok = search_tools._build_search_status([{"url": "https://example.com"}], engines, [])
    assert ok["state"] == "ok"
    assert ok["working_engine_count"] == 3

    empty = search_tools._build_search_status([], engines, [])
    assert empty["state"] == "empty"
    assert empty["working_engine_count"] == 3

    degraded = search_tools._build_search_status(
        [], engines, [{"engine": "sogou", "reason": "captcha"}]
    )
    assert degraded["state"] == "degraded"
    assert degraded["working_engine_count"] == 2

    unavailable = search_tools._build_search_status(
        [], engines, [
            {"engine": "sogou", "reason": "captcha"},
            {"engine": "quark", "reason": "timeout"},
            {"engine": "360search", "reason": "suspended"},
        ]
    )
    assert unavailable["state"] == "unavailable"
    assert unavailable["working_engine_count"] == 0


def test_results_are_kept_when_failures_exist():
    status = search_tools._build_search_status(
        [{"url": "https://example.com"}],
        ["sogou"],
        [{"engine": "sogou", "reason": "timeout"}],
    )
    assert status["state"] == "degraded"
    assert status["result_count"] == 1


def test_unrequested_engine_failure_does_not_degrade_status():
    status = search_tools._build_search_status(
        [],
        ["sogou"],
        [{"engine": "bing", "reason": "timeout"}],
    )

    assert status["state"] == "empty"
    assert status["working_engine_count"] == 1
    assert status["failed_engines"] == []


def test_build_response_distinguishes_empty_degraded_and_unavailable_notes():
    empty = search_tools._build_search_response(
        "cold entity", [], "sogou,quark", {}, kind="web"
    )
    assert empty["search_status"]["state"] == "empty"
    assert "更短/更宽" in empty["note"]

    degraded = search_tools._build_search_response(
        "cold entity", [], "sogou,quark",
        {"unresponsive_engines": [["sogou", "timeout"]]}, kind="web",
    )
    assert degraded["search_status"]["state"] == "degraded"
    assert "不能据此判断" in degraded["note"]

    unavailable = search_tools._build_search_response(
        "cold entity", [], "sogou,quark",
        {"unresponsive_engines": [["sogou", "captcha"], ["quark", "timeout"]]},
        kind="web",
    )
    assert unavailable["search_status"]["state"] == "unavailable"
    assert "不代表没有" in unavailable["note"]
    assert "deep_research" in unavailable["note"]


def test_search_health_log_does_not_log_query_text(caplog):
    secret_query = "TOP-SECRET-QUERY-TEXT"
    with caplog.at_level(logging.INFO, logger="agent.search"):
        search_tools._build_search_response(
            secret_query,
            [],
            "sogou",
            {"unresponsive_engines": [["sogou", "captcha"]]},
            kind="web",
        )

    assert secret_query not in caplog.text
    assert '"state": "unavailable"' in caplog.text
    assert f'"query_len": {len(secret_query)}' in caplog.text


class _FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, params=None):
        return _FakeResponse(self._payload)


def _settings(*, engines="sogou,quark,360search", image_engines=""):
    return SimpleNamespace(search=SimpleNamespace(
        searxng_url="http://127.0.0.1:8888",
        searxng_engines=engines,
        searxng_image_engines=image_engines,
        max_results=5,
    ))


async def test_web_search_surfaces_all_engine_failure_as_unavailable(monkeypatch):
    payload = {
        "results": [],
        "unresponsive_engines": [
            ["sogou", "CAPTCHA"],
            ["quark", "timeout"],
            ["360search", "suspended"],
        ],
    }
    monkeypatch.setattr(search_tools, "get_settings", lambda: _settings())
    monkeypatch.setattr(
        search_tools.httpx, "AsyncClient", lambda **kwargs: _FakeClient(payload)
    )

    result = await search_tools._searxng_search(None, None, {"query": "SGLang founder interview"})

    assert result["results"] == []
    assert result["search_status"]["state"] == "unavailable"
    assert result["search_status"]["requested_engines"] == ["sogou", "quark", "360search"]
    assert "这不代表没有相关结果" in result["note"]


async def test_web_search_timeout_switches_to_deep_research(monkeypatch):
    monkeypatch.setattr(search_tools, "get_settings", lambda: _settings())

    class _TimeoutClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, params=None):
            raise httpx.ReadTimeout("SearXNG read timeout")

    async def _fallback(db, user_id, args):
        assert args == {"query": "北京天气", "max_results": 5}
        return {"source": "deep_research", "results": []}

    monkeypatch.setattr(search_tools.httpx, "AsyncClient", lambda **kwargs: _TimeoutClient())
    monkeypatch.setattr(search_tools, "_deep_research", _fallback)

    result = await search_tools._searxng_search(None, 7, {"query": "北京天气"})

    assert result == {"source": "deep_research", "results": []}


async def test_image_search_reuses_status_and_keeps_results_when_degraded(monkeypatch):
    payload = {
        "results": [{
            "title": "cat",
            "url": "https://example.com/page",
            "img_src": "https://example.com/cat.jpg",
            "thumbnail": "https://example.com/thumb.jpg",
        }],
        "unresponsive_engines": [["quark", "timeout"]],
    }
    monkeypatch.setattr(
        search_tools, "get_settings", lambda: _settings(engines="sogou", image_engines="sogou,quark")
    )
    monkeypatch.setattr(
        search_tools.httpx, "AsyncClient", lambda **kwargs: _FakeClient(payload)
    )

    result = await search_tools._searxng_image_search(None, None, {"query": "orange cat"})

    assert len(result["results"]) == 1
    assert result["search_status"]["state"] == "degraded"
    assert result["search_status"]["requested_engines"] == ["sogou", "quark"]
    assert result["search_status"]["working_engine_count"] == 1


async def test_image_search_only_returns_candidates_without_visual_inspection(monkeypatch):
    payload = {"results": [{"title": "cat", "img_src": "https://example.com/cat.jpg"}]}
    monkeypatch.setattr(search_tools, "get_settings", lambda: _settings())
    monkeypatch.setattr(search_tools.httpx, "AsyncClient", lambda **kwargs: _FakeClient(payload))

    result = await search_tools._searxng_image_search(None, None, {"query": "cat", "inspect_images": True})

    assert "_vision_images" not in result
    assert result["results"][0]["img_src"] == "https://example.com/cat.jpg"


async def test_inspect_images_reads_only_model_selected_results(monkeypatch):
    search_tools.reset_image_inspection_budget()
    seen = []

    async def _inspect(url):
        seen.append(url)
        return {"block": {"type": "image", "source": {"type": "base64", "data": url}}}

    monkeypatch.setattr("agent.tools.files.inspect_image_url", _inspect)
    result = await search_tools._inspect_images(None, None, {
        "images": [
            {"result_id": "image-2", "img_src": "https://example.com/two.jpg", "title": "第二张"},
            {"result_id": "image-5", "img_src": "https://example.com/five.jpg", "title": "第五张"},
        ],
    })

    assert seen == ["https://example.com/two.jpg", "https://example.com/five.jpg"]
    assert [item["result_id"] for item in result["_vision_images"]] == ["image-2", "image-5"]

    second = await search_tools._inspect_images(None, None, {
        "images": [{"result_id": "image-9", "img_src": "https://example.com/nine.jpg"}],
    })
    assert "已经读取过网络图片" in second["error"]


async def test_inspect_images_accepts_similar_image_result_url(monkeypatch):
    search_tools.reset_image_inspection_budget()
    seen = []

    async def _inspect(url):
        seen.append(url)
        return {"block": {"type": "image", "source": {"type": "base64", "data": "x"}}}

    monkeypatch.setattr("agent.tools.files.inspect_image_url", _inspect)
    result = await search_tools._inspect_images(None, None, {
        "images": [{
            "result_id": "similar-1",
            "image_url": "https://example.com/similar.jpg",
            "title": "相似候选",
        }],
    })

    assert seen == ["https://example.com/similar.jpg"]
    assert result["inspected_count"] == 1
    assert result["_vision_images"][0]["result_id"] == "similar-1"


async def test_inspect_images_rejects_more_than_twenty_targets():
    result = await search_tools._inspect_images(None, None, {
        "images": [{"result_id": str(index), "img_src": "https://example.com/x.jpg"} for index in range(21)],
    })

    assert "最多读取 20 张" in result["error"]


async def test_inspect_images_can_read_historical_attachment(monkeypatch):
    search_tools.reset_image_inspection_budget()
    from app.core import chat_attach

    async def _get_meta(user_id, attach_id):
        return {"attach_id": attach_id, "ext": "jpeg", "storage_key": "u/.chat_staging/x.jpeg"}

    async def _read_bytes(meta):
        return b"image-bytes"

    monkeypatch.setattr(chat_attach, "get_meta", _get_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", _read_bytes)
    monkeypatch.setattr(chat_attach, "vision_block", lambda data, ext: {
        "type": "image", "source": {"type": "base64", "data": "x"},
    })

    result = await search_tools._inspect_images(None, "user-1", {
        "images": [{"attach_id": "abc123", "title": "历史图片"}],
    })

    assert result["_vision_images"][0]["attach_id"] == "abc123"


def test_search_tool_schemas_expose_query_contract_and_max_results_bounds():
    tools = {tool.name: tool for tool in search_tools.SearchSkill.tools}

    for name in ("web_search", "image_search"):
        query = tools[name].input_schema["properties"]["query"]
        max_results = tools[name].input_schema["properties"]["max_results"]
        assert "不要直接复制用户的完整问题" in query["description"]
        assert max_results["minimum"] == 1
        assert max_results["maximum"] == 20

    assert "inspect_images" not in tools["image_search"].input_schema["properties"]
    assert tools["inspect_images"].input_schema["properties"]["images"]["maxItems"] == 20

    deep_max = tools["deep_research"].input_schema["properties"]["max_results"]
    assert deep_max["minimum"] == 1
    assert deep_max["maximum"] == 20
