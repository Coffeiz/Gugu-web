"""P2-b §7 步骤 4：外部 I/O 封装重试——storage(OSS)/voice(ASR)/web(http_get) 三个调用点。

对应 docs/refactor/P2b-错误处理规则.md §4-A 标杆模板：窄瞬时白名单 + 有界退避 +
用尽 raise RetryableError（或按调用点既有契约降级，见 voice.py 的说明）；4xx/非瞬时
错误不重试、直接失败。

用 mock 打瞬时错误验证重试次数与退避调用，不打真 OSS/ASR/网络。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.errors import RetryableError


# ── storage: OSSStorageBackend.put/get/delete ──────────────────────────────────

def _make_oss_backend():
    from app.services.storage import OSSStorageBackend
    backend = OSSStorageBackend.__new__(OSSStorageBackend)  # 跳过 __init__（不建真 oss2.Bucket）
    backend.bucket = SimpleNamespace()
    backend.pfx = ""
    return backend


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """重试测试不用真等退避秒数——把 asyncio.sleep 打成立即返回，只验证调用次数/行为。"""
    async def _fast_sleep(_seconds):
        return None
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)


async def test_oss_put_retries_on_request_error_then_succeeds():
    import oss2.exceptions as oss_exc
    backend = _make_oss_backend()
    calls = {"n": 0}

    def flaky_put(key, data, headers=None):
        calls["n"] += 1
        if calls["n"] < 3:
            raise oss_exc.RequestError(ConnectionError("conn reset"))
        return None

    backend.bucket.put_object = flaky_put
    await backend.put("k", b"data")
    assert calls["n"] == 3   # 失败 2 次 + 成功 1 次


async def test_oss_get_exhausts_retries_raises_retryable_with_cause():
    import oss2.exceptions as oss_exc
    backend = _make_oss_backend()
    inner = oss_exc.RequestError(ConnectionError("still down"))

    def always_fail(key):
        raise inner

    backend.bucket.get_object = always_fail
    with pytest.raises(RetryableError) as exc_info:
        await backend.get("k")
    assert exc_info.value.cause is inner
    assert exc_info.value.attempt == 3   # len(_OSS_RETRY_BACKOFF) == 3 → 用尽后 attempt=3
    assert exc_info.value.code == "oss.get_timeout"


async def test_oss_delete_retries_on_5xx_server_error():
    import oss2.exceptions as oss_exc
    backend = _make_oss_backend()
    calls = {"n": 0}

    def flaky_delete(key):
        calls["n"] += 1
        if calls["n"] < 2:
            raise oss_exc.ServerError(500, {}, b"", {"Code": "InternalError"})
        return None

    backend.bucket.delete_object = flaky_delete
    await backend.delete("k")
    assert calls["n"] == 2


async def test_oss_put_does_not_retry_on_4xx():
    """4xx（鉴权/参数错等）= 可预期或永久失败，不重试，直接失败（P2-b §1）。"""
    import oss2.exceptions as oss_exc
    backend = _make_oss_backend()
    calls = {"n": 0}

    def denied(key, data, headers=None):
        calls["n"] += 1
        raise oss_exc.AccessDenied(403, {}, b"", {"Code": "AccessDenied"})

    backend.bucket.put_object = denied
    with pytest.raises(oss_exc.AccessDenied):
        await backend.put("k", b"data")
    assert calls["n"] == 1   # 一次就失败，没有重试


async def test_oss_get_does_not_retry_on_unrelated_exception():
    """非 oss2 异常（比如编程错误）不在白名单内，原样上抛、不重试。"""
    backend = _make_oss_backend()
    calls = {"n": 0}

    def boom(key):
        calls["n"] += 1
        raise ValueError("not an oss error")

    backend.bucket.get_object = boom
    with pytest.raises(ValueError):
        await backend.get("k")
    assert calls["n"] == 1


# ── storage: OSSStorageBackend.stat（用于 read_audio 的物理大小检查）─────────────

def _fake_meta_result(size, mtime=1700000000, etag="abc"):
    return SimpleNamespace(content_length=size, last_modified=mtime, etag=etag)


async def test_oss_stat_uses_get_object_meta_not_full_download():
    """stat() 必须走元信息查询，不能像默认实现那样整个 get() 下来只为量大小
    （真实故障：200MB 视频光 stat 一次就要拉 200MB）。

    用 get_object_meta 而不是 head_object：两者都只取元信息不下载本体，但
    head_object 对象不存在时抛的是 NotFound（HEAD 请求 404 时 SDK 分不清是
    "对象不存在"还是"bucket 配错"），get_object_meta 官方保证抛更精确的
    NoSuchKey——跟 stat() 的异常处理必须对得上，不能靠"顺便接住父类"蒙混过去
    （code review 复审发现：早期实现测试自己 mock 的是 NoSuchKey，跟 head_object
    真实抛出的 NotFound 对不上，测试全绿但语义是错的）。"""
    backend = _make_oss_backend()
    get_calls = {"n": 0}

    def fake_meta(key):
        return _fake_meta_result(12345)

    def fake_get(key):
        get_calls["n"] += 1
        raise AssertionError("stat() 不应该调用 get_object")

    backend.bucket.get_object_meta = fake_meta
    backend.bucket.get_object = fake_get
    info = await backend.stat("k")
    assert info.size == 12345
    assert info.mtime == 1700000000
    assert get_calls["n"] == 0


async def test_oss_stat_returns_none_when_missing():
    import oss2.exceptions as oss_exc
    backend = _make_oss_backend()

    def fake_meta(key):
        raise oss_exc.NoSuchKey(404, {}, b"", {"Code": "NoSuchKey"})

    backend.bucket.get_object_meta = fake_meta
    assert await backend.stat("missing") is None


# ── voice: transcribe() ASR 调用 ────────────────────────────────────────────────

def _voice_settings():
    return SimpleNamespace(voice={"model": "asr-model", "api_key": "k", "base_url": "http://x"})


def _media():
    import base64
    return [{"type": "audio", "mime": "audio/wav", "b64": base64.b64encode(b"fake-wav").decode()}]


async def test_voice_transcribe_retries_on_timeout_then_succeeds():
    from agent import voice

    import openai as _openai
    calls = {"n": 0}

    class _FakeCompletions:
        async def create(self, **kwargs):
            calls["n"] += 1
            if calls["n"] < 2:
                raise _openai.APITimeoutError(request=None)
            msg = SimpleNamespace(content="你好")
            choice = SimpleNamespace(message=msg)
            return SimpleNamespace(choices=[choice])

    class _FakeClient:
        def __init__(self, *a, **kw):
            self.chat = SimpleNamespace(completions=_FakeCompletions())

    with patch("openai.AsyncOpenAI", _FakeClient):
        out = await voice.transcribe(_media(), _voice_settings())
    assert out == "你好"
    assert calls["n"] == 2


async def test_voice_transcribe_exhausts_retries_returns_empty_not_raise():
    """ASR 重试用尽后按既有契约降级为空串，不上抛（调用方没有 except RetryableError，
    见 agent/runner.py：只判断 None/空串）。"""
    from agent import voice
    import openai as _openai
    calls = {"n": 0}

    class _FakeCompletions:
        async def create(self, **kwargs):
            calls["n"] += 1
            raise _openai.APIConnectionError(request=None)

    class _FakeClient:
        def __init__(self, *a, **kw):
            self.chat = SimpleNamespace(completions=_FakeCompletions())

    with patch("openai.AsyncOpenAI", _FakeClient):
        out = await voice.transcribe(_media(), _voice_settings())
    assert out == ""
    assert calls["n"] == len(voice._ASR_RETRY_BACKOFF) + 1


async def test_voice_transcribe_does_not_retry_on_permanent_error():
    """4xx 风格的永久错误（这里用普通 Exception 模拟「未知/鉴权失败」）不重试，一次失败即回空串。"""
    from agent import voice
    calls = {"n": 0}

    class _FakeCompletions:
        async def create(self, **kwargs):
            calls["n"] += 1
            raise ValueError("bad api key")

    class _FakeClient:
        def __init__(self, *a, **kw):
            self.chat = SimpleNamespace(completions=_FakeCompletions())

    with patch("openai.AsyncOpenAI", _FakeClient):
        out = await voice.transcribe(_media(), _voice_settings())
    assert out == ""
    assert calls["n"] == 1


async def test_voice_transcribe_qwen_audio_30_uses_dashscope_native_api():
    from agent import voice

    import httpx

    calls = []

    class _FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"output": {"choices": [{"message": {
                "content": [{"text": "这是 QQ 语音"}]
            }}]}}

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append((url, headers, json))
            return _FakeResponse()

    with patch.object(httpx, "AsyncClient", _FakeClient):
        out = await voice.transcribe(_media(), SimpleNamespace(voice={
            "model": "qwen-audio-3.0-asr-flash",
            "api_key": "k",
            "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            "api_format": "dashscope",
            "dashscope_service": "qwen-audio",
        }))

    assert out == "这是 QQ 语音"
    assert calls[0][0].endswith("/api/v1/services/aigc/multimodal-generation/generation")
    content = calls[0][2]["input"]["messages"][0]["content"][0]
    assert content["type"] == "input_audio"
    assert content["input_audio"]["data"].startswith("data:audio/wav;base64,")
    assert calls[0][2]["parameters"] == {"format": "wav", "sample_rate": 16000}


def test_dashscope_transcript_reads_qwen_audio_output_text():
    from agent.voice import _dashscope_transcript

    assert _dashscope_transcript({"output": {"text": "Qwen-Audio 结果"}}) == "Qwen-Audio 结果"


async def test_voice_transcribe_qwen3_asr_uses_native_asr_payload():
    from agent import voice

    import httpx

    calls = []

    class _FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"output": {"choices": [{"message": {
                "content": [{"text": "这是 qwen3 ASR 语音"}]
            }}]}}

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append((url, headers, json))
            return _FakeResponse()

    with patch.object(httpx, "AsyncClient", _FakeClient):
        out = await voice.transcribe(_media(), SimpleNamespace(voice={
            "model": "qwen3-asr-flash",
            "api_key": "k",
            "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            "api_format": "dashscope",
            "dashscope_service": "qwen3-asr",
        }))

    assert out == "这是 qwen3 ASR 语音"
    content = calls[0][2]["input"]["messages"][0]["content"][0]
    assert content["audio"].startswith("data:audio/wav;base64,")
    assert calls[0][2]["parameters"] == {"asr_options": {"enable_itn": False}}


async def test_voice_transcribe_fun_asr_uses_dashscope_audio_payload():
    """Fun-ASR 与 Qwen-Audio 共用 DashScope 原生 input_audio 协议。"""
    from agent import voice
    import httpx

    calls = []

    class _FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"output": {"choices": [{"message": {
                "content": [{"text": "这是 Fun-ASR 语音"}]
            }}]}}

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append((url, headers, json))
            return _FakeResponse()

    with patch.object(httpx, "AsyncClient", _FakeClient):
        out = await voice.transcribe(_media(), SimpleNamespace(voice={
            "model": "fun-asr-flash-2026-06-15",
            "api_key": "k",
            "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            "api_format": "dashscope",
            "dashscope_service": "fun-asr",
        }))

    assert out == "这是 Fun-ASR 语音"
    assert calls[0][0].endswith("/api/v1/services/aigc/multimodal-generation/generation")
    content = calls[0][2]["input"]["messages"][0]["content"][0]
    assert content["type"] == "input_audio"
    assert content["input_audio"]["data"].startswith("data:audio/wav;base64,")
    assert calls[0][2]["parameters"] == {"format": "wav", "sample_rate": 16000}


async def test_voice_transcribe_uses_explicit_dashscope_service_not_model_prefix():
    """产品线字段是协议选择的唯一来源，模型名相似也不能改变请求体。"""
    from agent import voice
    import httpx

    calls = []

    class _FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"output": {"choices": [{"message": {"content": [{"text": "ok"}]}}]}}

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append(json)
            return _FakeResponse()

    with patch.object(httpx, "AsyncClient", _FakeClient):
        out = await voice.transcribe(_media(), SimpleNamespace(voice={
            "model": "qwen3-asr-flash-custom",
            "api_key": "k",
            "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            "api_format": "dashscope",
            "dashscope_service": "qwen-audio",
        }))

    assert out == "ok"
    assert calls[0]["input"]["messages"][0]["content"][0]["type"] == "input_audio"
    assert calls[0]["parameters"] == {"format": "wav", "sample_rate": 16000}


async def test_voice_transcribe_accepts_dict_settings():
    from agent import voice

    import openai as _openai

    class _FakeCompletions:
        async def create(self, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content="测试成功")
            )])

    class _FakeClient:
        def __init__(self, *a, **kw):
            self.chat = SimpleNamespace(completions=_FakeCompletions())

    with patch("openai.AsyncOpenAI", _FakeClient):
        out = await voice.transcribe(_media(), {
            "voice": {"model": "asr-model", "api_key": "k", "base_url": "http://x",
                      "api_format": "openai"}
        })
    assert out == "测试成功"


# ── web: http_get 工具 ───────────────────────────────────────────────────────

async def test_http_get_retries_on_timeout_then_succeeds(monkeypatch):
    from agent.tools import web as web_mod

    calls = {"n": 0}

    class _FakeResponse:
        status_code = 200
        headers = {"content-type": "text/plain"}
        encoding = "utf-8"

        async def aiter_bytes(self):
            yield b"ok body"

    class _FakeStream:
        def __init__(self, response):
            self.response = response

        async def __aenter__(self):
            return self.response

        async def __aexit__(self, *a):
            return False

    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            calls["n"] += 1
            if calls["n"] < 2:
                raise httpx.ConnectTimeout("timed out")
            return _FakeStream(_FakeResponse())

    monkeypatch.setattr(web_mod, "resolve_pinned_ip", lambda url: ("93.184.216.34", None))
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    out = await web_mod._http_get(None, None, {"url": "https://example.com/x"})
    assert out["status"] == 200
    assert calls["n"] == 2


async def test_http_get_exhausts_retries_returns_error():
    from agent.tools import web as web_mod

    calls = {"n": 0}

    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            calls["n"] += 1
            raise httpx.ConnectTimeout("still timing out")

    with patch("agent.tools.web.resolve_pinned_ip", lambda url: ("93.184.216.34", None)), \
         patch.object(httpx, "AsyncClient", _FakeAsyncClient):
        out = await web_mod._http_get(None, None, {"url": "https://example.com/x"})
    assert "error" in out
    assert calls["n"] == len(web_mod._HTTP_GET_RETRY_BACKOFF) + 1


async def test_http_get_does_not_retry_on_non_transient_exception():
    """非白名单异常（如 URL/证书等编程侧问题）不重试，一次失败即返回 error。"""
    from agent.tools import web as web_mod

    calls = {"n": 0}

    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            calls["n"] += 1
            raise ValueError("unexpected")

    with patch("agent.tools.web.resolve_pinned_ip", lambda url: ("93.184.216.34", None)), \
         patch.object(httpx, "AsyncClient", _FakeAsyncClient):
        out = await web_mod._http_get(None, None, {"url": "https://example.com/x"})
    assert "error" in out
    assert calls["n"] == 1


async def test_http_get_stops_reading_oversized_response(monkeypatch):
    from agent.tools import web as web_mod

    class _FakeResponse:
        status_code = 200
        headers = {"content-type": "text/plain"}
        encoding = "utf-8"
        chunks_read = 0

        async def aiter_bytes(self):
            self.chunks_read += 1
            yield b"x" * (web_mod._MAX_DOWNLOAD_BYTES + 1)
            self.chunks_read += 1
            yield b"should not be read"

    response = _FakeResponse()

    class _FakeStream:
        async def __aenter__(self):
            return response

        async def __aexit__(self, *a):
            return False

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            return _FakeStream()

    monkeypatch.setattr(web_mod, "resolve_pinned_ip", lambda url: ("93.184.216.34", None))
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    out = await web_mod._http_get(None, None, {"url": "https://example.com/large"})
    assert "过大" in out["error"]
    assert response.chunks_read == 1


async def test_http_get_batch_preserves_order_and_allows_partial_failure(monkeypatch):
    from agent.tools import web as web_mod

    async def fake_one(_db, _user_id, url, _max_chars):
        await asyncio.sleep(0.01 if url.endswith("/a") else 0)
        if url.endswith("/bad"):
            return {"url": url, "error": "请求失败"}
        return {"url": url, "status": 200, "body": url}

    monkeypatch.setattr(web_mod, "_http_get_one", fake_one)
    out = await web_mod._http_get(None, None, {
        "urls": ["https://example.com/a", "https://example.com/b", "https://example.com/bad"],
    })

    assert [item["url"] for item in out["results"]] == [
        "https://example.com/a", "https://example.com/b", "https://example.com/bad",
    ]
    assert out["results"][0]["status"] == 200
    assert out["results"][2]["error"] == "请求失败"


async def test_http_get_batch_rejects_more_than_five_urls():
    from agent.tools import web as web_mod

    out = await web_mod._http_get(None, None, {
        "urls": [f"https://example.com/{index}" for index in range(6)],
    })

    assert out == {"error": "单次最多并行请求 5 个 URL"}


def test_http_get_schema_accepts_only_single_or_batch_url():
    from agent.tools import web as web_mod
    from agent.tools.tool_contract import build_validator, validate_input

    tool = web_mod.WebSkill().tools[0]
    validator = build_validator(tool.input_schema)
    assert validate_input(validator, {"url": "https://example.com"}) == []
    assert validate_input(validator, {"urls": ["https://example.com"]}) == []
    assert validate_input(validator, {
        "url": "https://example.com", "urls": ["https://example.com"],
    })
