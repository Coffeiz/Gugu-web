"""模型级推理状态策略回归。

推理接续只在显式 Responses（或原生支持续接的协议）下生效；Chat API 下的
自动协议探测/切换已随旧策略移除——数据库里的 summary/continuation 旧配置
一律回落 off，不再发起任何探测请求。
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
    assert resolve_run_config(_settings("summary")).reasoning_persistence == "summary"


def test_missing_model_policy_defaults_to_off():
    model = _settings("off").ai
    delattr(model, "reasoning_persistence")
    assert resolve_run_config(SimpleNamespace(ai=model, ai_presets=None)).reasoning_persistence == "off"


@pytest.mark.parametrize("mode", ["summary", "continuation"])
def test_chat_completions_disables_reasoning_persistence(mode):
    settings = _settings(mode)
    settings.ai.api_format = "openai"

    assert resolve_run_config(settings).reasoning_persistence == "off"


def test_known_openai_provider_empty_format_uses_chat_completions():
    settings = _settings("continuation", provider="qwen", api_format="")
    settings.ai.base_url = "https://example.com/anthropic"

    assert resolve_run_config(settings).reasoning_persistence == "off"


@pytest.mark.asyncio
async def test_legacy_continuation_no_longer_switches_protocol(monkeypatch):
    """旧配置（未知 Provider + continuation）不再触发任何协议探测/切换：
    api_format 原样保留、无提示标记、provider_diagnostics 里已无探测入口。"""
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
    assert cfg.reasoning_persistence == "continuation"  # 交回协议适配器自行解释


@pytest.mark.asyncio
async def test_explicit_chat_keeps_off_for_stale_persistence():
    settings = _settings("continuation", provider="openai", api_format="openai")
    settings.ai.api_format = "openai"

    cfg = await llm_select.resolve_run_config_for_user(settings, None, "uid")

    assert cfg.model.api_format == "openai"
    assert cfg.reasoning_persistence == "off"
