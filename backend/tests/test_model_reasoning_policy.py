"""模型级推理状态策略回归。

推理接续只在显式 Responses（或原生支持续接的协议）下生效；Chat API 下的
自动协议探测/切换已移除；推理状态策略只允许 off 与 continuation。
"""
from types import SimpleNamespace

import pytest

import agent.llm.llm_select as llm_select
from agent.llm.llm_select import resolve_run_config


def _settings(mode: str, *, provider: str = "openai", api_format: str = "responses"):
    model = SimpleNamespace(
        provider=provider,
        api_format=api_format,
        base_url="https://api.openai.com/v1",
        model="gpt-test",
        context_tokens=32_000,
        max_tokens=2_000,
        reasoning_persistence=mode,
    )
    return SimpleNamespace(ai=model, ai_presets=None)


def test_run_policy_comes_from_selected_model():
    assert resolve_run_config(_settings("continuation")).reasoning_persistence == "continuation"
    with pytest.raises(ValueError, match="无效的推理状态持久化策略"):
        resolve_run_config(_settings("summary"))


def test_missing_model_policy_defaults_to_off():
    model = _settings("off").ai
    delattr(model, "reasoning_persistence")
    assert resolve_run_config(SimpleNamespace(ai=model, ai_presets=None)).reasoning_persistence == "off"


def test_chat_completions_disables_reasoning_persistence():
    settings = _settings("continuation")
    settings.ai.api_format = "openai"

    assert resolve_run_config(settings).reasoning_persistence == "off"


def test_known_openai_provider_empty_format_uses_chat_completions():
    settings = _settings("continuation", provider="qwen", api_format="")
    settings.ai.base_url = "https://example.com/anthropic"

    assert resolve_run_config(settings).reasoning_persistence == "off"


@pytest.mark.asyncio
async def test_unknown_provider_does_not_switch_protocol_or_enable_chat_continuation(monkeypatch):
    """未知 Provider 不触发协议探测；适配器识别为 Chat 时关闭跨请求续接。"""
    import app.services.provider_diagnostics as diagnostics

    assert not hasattr(diagnostics, "probe_responses_capability")
    assert not hasattr(diagnostics, "record_responses_capability_failure")

    async def _fail_probe(**kwargs):
        raise AssertionError("探测机械已移除，不应有任何协议探测调用")

    monkeypatch.setattr("agent.providers.OpenAIAdapter.protocol_format",
                        lambda self, ai: "openai", raising=False)
    cfg = await llm_select.resolve_run_config_for_user(
        _settings("continuation", provider="other", api_format=""), None, "uid")

    assert cfg.model.api_format == ""            # 未被改成 responses
    assert cfg.reasoning_notice is None          # 不再有探测失败提示
    assert cfg.reasoning_persistence == "off"  # Chat 协议没有可恢复的跨请求状态


@pytest.mark.asyncio
async def test_explicit_chat_keeps_off_for_stale_persistence():
    settings = _settings("continuation", provider="openai", api_format="openai")
    settings.ai.api_format = "openai"

    cfg = await llm_select.resolve_run_config_for_user(settings, None, "uid")

    assert cfg.model.api_format == "openai"
    assert cfg.reasoning_persistence == "off"
