"""语音预设与 BYOK 共用表单后的持久化、产品线和 Key 目的地边界。"""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.api.v1 import agent_admin
from app.byok import service
from app.core.config import VoiceSettings


@pytest.fixture
def voice_document(monkeypatch):
    document = {"voice_presets": {"active_id": "v_test", "items": [{
        "id": "v_test", "name": "测试语音", "provider": "qwen", "api_key": "synthetic-test-key",
        "base_url": "https://voice.example.test", "model": "qwen3-asr-flash",
        "api_format": "dashscope", "dashscope_service": "qwen3-asr",
    }]}}
    monkeypatch.setattr(agent_admin, "_read_override", lambda: deepcopy(document))
    def mutate(callback):
        draft = deepcopy(document)
        result = callback(draft)
        document.clear()
        document.update(draft)
        return result
    monkeypatch.setattr(agent_admin, "_mutate_override", mutate)
    return document


@pytest.mark.asyncio
async def test_voice_model_edit_reloads_with_matching_native_service_and_masked_key(voice_document):
    await agent_admin.update_voice_preset("v_test", agent_admin.VoicePresetUpdate(model="fun-asr-flash"))
    result = await agent_admin.list_voice_presets()
    assert result["items"][0]["model"] == "fun-asr-flash"
    assert result["items"][0]["dashscope_service"] == "fun-asr"
    assert result["items"][0]["has_api_key"] is True
    assert result["items"][0]["api_key"] != "synthetic-test-key"
    assert voice_document["voice_presets"]["items"][0]["api_key"] == "synthetic-test-key"


@pytest.mark.asyncio
async def test_destination_change_rejects_old_key_without_mutating_saved_preset(voice_document):
    before = deepcopy(voice_document)
    with pytest.raises(HTTPException) as error:
        await agent_admin.update_voice_preset("v_test", agent_admin.VoicePresetUpdate(base_url="https://other.example.test"))
    assert error.value.status_code == 422
    assert voice_document == before


@pytest.mark.asyncio
async def test_models_preview_reuses_saved_key_only_for_its_destination(voice_document, monkeypatch):
    fetch = AsyncMock(return_value=["qwen3-asr-flash"])
    monkeypatch.setattr(agent_admin, "_fetch_provider_models", fetch)
    body = agent_admin.VoiceModelsPreview(preset_id="v_test", provider="qwen", base_url="https://voice.example.test", api_format="dashscope")
    assert (await agent_admin.preview_voice_preset_models(body))["models"] == ["qwen3-asr-flash"]
    assert fetch.await_args.args[2] == "synthetic-test-key"
    body.base_url = "https://other.example.test"
    with pytest.raises(HTTPException):
        await agent_admin.preview_voice_preset_models(body)
    assert fetch.await_count == 1


@pytest.mark.asyncio
async def test_qwen_compatible_voice_preset_is_not_forced_to_native(voice_document):
    result = await agent_admin.create_voice_preset(agent_admin.VoicePresetPayload(
        name="兼容语音", provider="qwen", model="audio-model", api_format="openai", base_url="https://voice.example.test"))
    assert result["item"]["api_format"] == "openai"


@pytest.mark.asyncio
async def test_byok_native_voice_does_not_inherit_platform_product_line(monkeypatch):
    row = SimpleNamespace(provider="qwen", api_format="dashscope", base_url="https://voice.example.test", model="fun-asr-flash",
                          image=False, video=False, audio=False, image_detail="auto")
    monkeypatch.setattr(service, "get_active_credential", AsyncMock(return_value=row))
    monkeypatch.setattr(service, "decrypt_value", lambda _: "synthetic-user-key")
    result = await service.resolve_capability_settings(None, None, "speech_to_text", VoiceSettings(model="qwen3-asr-flash"))
    assert result.model == "fun-asr-flash"
    assert result.dashscope_service == "fun-asr"
    assert result.api_key == "synthetic-user-key"


@pytest.mark.asyncio
async def test_byok_native_voice_test_uses_the_same_product_line_as_runtime(monkeypatch):
    from app.api.v1 import byok, config
    probe = AsyncMock(return_value={"ok": True, "message": "测试通过"})
    monkeypatch.setattr(config, "test_voice", probe)
    result = await byok._test_native_voice_if_needed(capability="speech_to_text", provider="qwen", api_format="dashscope",
                                                    api_key="synthetic-key", base_url="https://voice.example.test", model="qwen-audio-3.0-asr-flash")
    assert result["ok"] is True
    body = probe.await_args.args[0]
    assert body.dashscope_service == "qwen-audio"
    assert body.use_config is False
    assert body.base_url == "https://voice.example.test"


@pytest.mark.asyncio
async def test_native_voice_model_list_uses_same_domain_catalog_without_changing_configuration(monkeypatch):
    import httpx
    request = AsyncMock(return_value=SimpleNamespace(status_code=200, json=lambda: {"data": [{"id": "qwen3-asr-flash"}]}))
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_):
            return False
        get = request
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    models = await agent_admin._fetch_provider_models(
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", "qwen", "synthetic-key", "dashscope")
    assert models == ["qwen3-asr-flash"]
    assert request.await_args.args[0] == "https://dashscope.aliyuncs.com/compatible-mode/v1/models"


@pytest.mark.asyncio
async def test_models_preview_post_route_matches_and_rejects_missing_key_before_network(monkeypatch):
    from fastapi import FastAPI
    import httpx
    fetch = AsyncMock(return_value=['test-asr'])
    monkeypatch.setattr(agent_admin, '_fetch_provider_models', fetch)
    app = FastAPI()
    app.include_router(agent_admin.router, prefix='/api/v1')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        missing = await client.post('/api/v1/admin/agent/voice-presets/models-preview', json={'provider': 'openai'})
        assert missing.status_code == 422
        fetch.assert_not_awaited()
        result = await client.post('/api/v1/admin/agent/voice-presets/models-preview', json={'provider': 'openai', 'api_key': 'synthetic-key'})
        assert result.status_code == 200
        assert result.json()['models'] == ['test-asr']
