"""模型级推理状态策略回归。"""
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
async def test_continuation_probes_responses_before_switching(monkeypatch):
    calls = []

    async def probe(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "status": 200}

    monkeypatch.setattr("app.services.provider_diagnostics.probe_responses_capability", probe)
    cfg = await llm_select.resolve_run_config_for_user(
        _settings("continuation", provider="other", api_format=""), None, "uid")

    assert cfg.model.api_format == "responses"
    assert cfg.reasoning_notice is None
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_explicit_chat_does_not_probe_responses_for_stale_persistence(monkeypatch):
    async def probe(**kwargs):
        raise AssertionError("显式 Chat Completions 不应探测 Responses")

    monkeypatch.setattr("app.services.provider_diagnostics.probe_responses_capability", probe)
    settings = _settings("continuation", provider="openai", api_format="openai")
    settings.ai.api_format = "openai"

    cfg = await llm_select.resolve_run_config_for_user(settings, None, "uid")

    assert cfg.model.api_format == "openai"
    assert cfg.reasoning_persistence == "off"


@pytest.mark.asyncio
async def test_failed_responses_probe_keeps_chat_completions_and_notifies(monkeypatch):
    async def probe(**kwargs):
        return {"ok": False, "status": 404}

    monkeypatch.setattr("app.services.provider_diagnostics.probe_responses_capability", probe)
    settings = _settings("continuation", provider="other", api_format="")
    settings.ai.base_url = "https://unsupported-responses.example/v1"
    cfg = await llm_select.resolve_run_config_for_user(settings, None, "uid")

    assert cfg.model.api_format == ""
    assert cfg.reasoning_notice == "当前接口不支持推理续接"


@pytest.mark.asyncio
async def test_failed_responses_probe_is_reused_for_same_configuration(monkeypatch):
    import app.services.provider_diagnostics as diagnostics

    diagnostics._responses_probe_cache.clear()
    diagnostics._responses_probe_tasks.clear()
    calls = 0

    async def probe_once(**kwargs):
        nonlocal calls
        calls += 1
        return {"ok": False, "status": 404}

    monkeypatch.setattr(diagnostics, "_probe_responses_once", probe_once)
    first = await diagnostics.probe_responses_capability(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1", model="gpt-test",
    )
    second = await diagnostics.probe_responses_capability(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1", model="gpt-test",
    )

    assert first == second == {"ok": False, "status": 404}
    assert calls == 1


@pytest.mark.asyncio
async def test_transient_responses_probe_failure_expires(monkeypatch):
    import app.services.provider_diagnostics as diagnostics

    diagnostics._responses_probe_cache.clear()
    diagnostics._responses_probe_tasks.clear()
    clock = 100.0
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: clock)
    calls = 0

    async def probe_once(**kwargs):
        nonlocal calls
        calls += 1
        return {"ok": False, "status": 503}

    monkeypatch.setattr(diagnostics, "_probe_responses_once", probe_once)
    first = await diagnostics.probe_responses_capability(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1", model="gpt-test",
    )
    clock = 150.0
    second = await diagnostics.probe_responses_capability(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1", model="gpt-test",
    )
    clock = 161.0
    third = await diagnostics.probe_responses_capability(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1", model="gpt-test",
    )

    assert first == second == third == {"ok": False, "status": 503}
    assert calls == 2


def test_runtime_responses_failure_overrides_success_probe_cache():
    import app.services.provider_diagnostics as diagnostics

    diagnostics._responses_probe_cache.clear()
    diagnostics.record_responses_capability_failure(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1",
        model="gpt-test", status=400,
    )

    key = diagnostics._responses_probe_key(
        provider="openai", api_key="sk-test", base_url="https://example.test/v1",
        model="gpt-test",
    )
    assert diagnostics._responses_probe_cache[key][1] == {
        "ok": False, "status": 400, "detail": "真实请求不支持 Responses 协议",
    }
