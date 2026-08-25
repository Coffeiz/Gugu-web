"""PRD-LLM-7 P3：本地运行时协议、Admin 接口和能力 freshness 回归。"""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from agent import providers
from agent.loop_drivers import OllamaDriver
from app.api.v1 import agent_admin


class _Response:
    def __init__(self, status_code=200, payload=None, lines=()):
        self.status_code = status_code
        self._payload = payload or {}
        self._lines = list(lines)
        self.text = "上游错误"

    def json(self):
        return self._payload

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "上游错误", request=httpx.Request("POST", "http://local.test"), response=self,
            )


class _Stream:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _OllamaClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def stream(self, method, url, *, json):
        self.calls.append((method, url, json))
        return _Stream(self.response)


def _ollama_ai(**extra):
    values = {
        "provider": "ollama",
        "model": "qwen3:8b",
        "api_key": "",
        "base_url": "http://127.0.0.1:11434/api",
        "ollama_api_mode": "native",
        "ollama_mode": "local",
        "thinking": "disabled",
        "reasoning_effort": "medium",
        "max_tokens": 32,
        "temperature": 0,
        "ollama_keep_alive": "5m",
    }
    values.update(extra)
    return SimpleNamespace(**values)


@pytest.mark.asyncio
async def test_ollama_native_stream_and_tool_roundtrip(monkeypatch):
    response = _Response(lines=[
        '{"message":{"content":"先查一下。"}}',
        '{"message":{"tool_calls":[{"function":{"name":"probe_noop","arguments":{"x":1}}}]}}',
        '{"done":true,"prompt_eval_count":12,"eval_count":3}',
    ])
    client = _OllamaClient(response)
    monkeypatch.setattr(providers, "build_ollama_client", lambda ai, timeout: client)
    monkeypatch.setattr(
        "agent.tools.registry.openai_schemas",
        lambda names: [{"type": "function", "function": {"name": name}} for name in names],
    )

    driver = OllamaDriver()
    _, context = driver.prepare(["probe_noop"], _ollama_ai(), [], None)
    events = [event async for event in driver.run_round(client, context, [])]

    assert events[0] == ("token", "先查一下。")
    result = events[-1][1]
    assert result.requires_tools is True
    assert result.tool_calls[0].name == "probe_noop"
    assert result.tool_calls[0].input == {"x": 1}
    assert result.usage_in == 12
    assert result.usage_out == 3
    assert client.calls[0][1].endswith("/chat")
    assert client.calls[0][2]["tools"][0]["function"]["name"] == "probe_noop"

    messages = []
    driver.append_tool_round(messages, result, [(result.tool_calls[0], '{"ok":true}')])
    assert messages[0]["role"] == "assistant"
    assert messages[0]["tool_calls"][0]["function"]["name"] == "probe_noop"
    assert messages[1] == {"role": "tool", "content": '{"ok":true}'}


@pytest.mark.asyncio
async def test_local_capability_probe_classifies_tool_and_json_server_rejection(monkeypatch):
    class _ProbeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, **kwargs):
            return _Response(payload={"data": [{"id": "local-model"}]})

        async def post(self, url, *, json, **kwargs):
            if "tools" in json or "response_format" in json:
                return _Response(status_code=400)
            return _Response(payload={"choices": [{"message": {"content": "OK"}}]})

        def stream(self, method, url, *, headers, json):
            return _Stream(_Response(lines=['{"choices":[]}']))

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: _ProbeClient())
    result = await agent_admin._probe_local_capabilities({
        "provider": "local",
        "local_runtime": "llama.cpp",
        "base_url": "http://127.0.0.1:8080/v1",
        "model": "local-model",
        "api_key": "",
    })

    assert result["chat"]["status"] == "支持"
    assert result["stream"]["status"] == "支持"
    assert result["tools"]["status"] == "需服务端配置"
    assert result["json_object"]["status"] == "需服务端配置"
    assert result["json_schema"]["status"] == "需服务端配置"
    assert result["reasoning"]["status"] == "未检测"


@pytest.mark.asyncio
async def test_admin_preset_response_masks_api_key(monkeypatch):
    override = {"ai_presets": {"active_id": "", "items": []}}
    monkeypatch.setattr(agent_admin, "_read_override", lambda: override)
    monkeypatch.setattr(agent_admin, "_write_override", lambda value: None)

    result = await agent_admin.create_llm_preset(agent_admin.PresetCreate(
        name="本地测试模型", provider="local", api_key="secret-local-key",
        deployment_mode="local", local_runtime="llama.cpp",
        base_url="http://127.0.0.1:8080/v1", model="local-model",
    ))

    assert result["api_key"].startswith("sec")
    assert result["api_key"].endswith("-key")
    assert "secret-local-key" not in result["api_key"]
    assert "secret-local-key" not in result.values()
    assert override["ai_presets"]["items"][0]["api_key"] == "secret-local-key"


@pytest.mark.asyncio
async def test_model_list_auth_error_is_classified_without_returning_upstream_body(monkeypatch):
    class _ModelsClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, **kwargs):
            response = _Response(status_code=401)
            response.text = "secret upstream response"
            return response

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: _ModelsClient())
    with pytest.raises(HTTPException) as exc:
        await agent_admin._fetch_provider_models(
            "http://127.0.0.1:8080/v1", "local", "secret-key", "openai",
        )
    assert exc.value.status_code == 502
    assert exc.value.detail == "服务商鉴权失败"
    assert "secret" not in str(exc.value.detail)


@pytest.mark.asyncio
async def test_capability_fingerprint_changes_when_model_changes(monkeypatch):
    override = {"ai_presets": {"active_id": "local-1", "items": [{
        "id": "local-1", "provider": "local", "local_runtime": "vllm",
        "base_url": "http://127.0.0.1:8000/v1", "model": "model-a", "api_key": "",
    }]}}
    monkeypatch.setattr(agent_admin, "_read_override", lambda: override)
    monkeypatch.setattr(agent_admin, "_write_override", lambda value: None)
    async def fake_probe(item):
        return _probe_result()

    monkeypatch.setattr(agent_admin, "_probe_local_capabilities", fake_probe)

    first = await agent_admin.probe_llm_capabilities("local-1")
    override["ai_presets"]["items"][0]["model"] = "model-b"
    second = await agent_admin.probe_llm_capabilities("local-1")

    assert first["fingerprint"] != second["fingerprint"]
    assert override["ai_presets"]["items"][0]["capability_fingerprint"] == second["fingerprint"]
    assert override["ai_presets"]["items"][0]["capability_checked_at"] == second["checked_at"]


@pytest.mark.asyncio
async def test_vision_probe_preview_supports_unsaved_preset(monkeypatch):
    async def fake_probe(provider, api_key, base_url, model, api_format, *, dim):
        return True, 200, f"支持{dim}"

    monkeypatch.setattr(agent_admin, "_do_vision_probe", fake_probe)
    result = await agent_admin.probe_vision_preview(
        agent_admin.VisionProbePreview(
            provider="openai", base_url="http://127.0.0.1:8000/v1", model="vision-model",
        ),
        dim="image",
    )

    assert result["supported"] is True
    assert result["dim"] == "image"


@pytest.mark.asyncio
async def test_vision_probe_persists_definitive_capabilities(monkeypatch):
    item = {
        "id": "vision-1", "provider": "openai", "api_key": "", "base_url": "http://local/v1",
        "model": "vision-model", "vision": False, "vision_video": False, "vision_audio": False,
    }
    override = {"ai_presets": {"active_id": "vision-1", "items": [item]}}
    monkeypatch.setattr(agent_admin, "_read_override", lambda: override)
    monkeypatch.setattr(agent_admin, "_write_override", lambda value: None)

    async def fake_probe(provider, api_key, base_url, model, api_format, *, dim):
        return (dim == "image"), 200, "明确结果"

    monkeypatch.setattr(agent_admin, "_do_vision_probe", fake_probe)
    result = await agent_admin.probe_vision_preset("vision-1")

    assert result["results"]["image"]["supported"] is True
    assert item["vision"] is True
    assert item["vision_video"] is False
    assert item["vision_audio"] is False
    assert override["ai"]["vision"] is True


def _probe_result():
    return {
        key: {"status": "支持", "detail": "HTTP 200"}
        for key in ("chat", "stream", "tools", "json_object", "json_schema")
    } | {"reasoning": {"status": "未检测", "detail": "人工确认"}}
