"""LLM 预设模型列表接口回归测试。"""

import pytest

from app.api.v1 import agent_admin


def _preset():
    return {
        "id": "deepseek-test",
        "provider": "deepseek",
        "base_url": "https://api.deepseek.com",
        "api_key": "sk-test",
        "api_format": "openai",
        "local_runtime": "other",
    }


@pytest.mark.asyncio
async def test_saved_preset_model_list_uses_provider_model_contract(monkeypatch):
    override = {"ai_presets": {"items": [_preset()]}}
    calls = []

    async def fake_fetch(base_url, provider, api_key, api_format=""):
        calls.append((base_url, provider, api_key, api_format))
        return ["deepseek-chat"]

    monkeypatch.setattr(agent_admin, "_read_override", lambda: override)
    monkeypatch.setattr(agent_admin, "_fetch_provider_models", fake_fetch)

    result = await agent_admin.list_llm_preset_models("deepseek-test")

    assert result == {"models": ["deepseek-chat"], "source": "provider"}
    assert calls == [("https://api.deepseek.com", "deepseek", "sk-test", "openai")]


@pytest.mark.asyncio
async def test_preview_model_list_does_not_pass_local_runtime(monkeypatch):
    calls = []

    async def fake_fetch(base_url, provider, api_key, api_format=""):
        calls.append((base_url, provider, api_key, api_format))
        return ["deepseek-reasoner"]

    monkeypatch.setattr(agent_admin, "_fetch_provider_models", fake_fetch)

    result = await agent_admin.preview_llm_preset_models(
        agent_admin.ModelsPreview(
            provider="deepseek",
            base_url="https://api.deepseek.com",
            api_key="sk-test",
            api_format="openai",
            local_runtime="other",
        )
    )

    assert result == {"models": ["deepseek-reasoner"], "source": "provider"}
    assert calls == [("https://api.deepseek.com", "deepseek", "sk-test", "openai")]
