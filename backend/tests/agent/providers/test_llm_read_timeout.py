"""主对话四种协议统一使用五分钟读取空闲超时。"""
from types import SimpleNamespace

import pytest

from app.core.retry import LLM_READ_TIMEOUT_SECONDS


class _ToolSnapshot:
    def anthropic_schemas(self, _names):
        return []

    def openai_schemas(self, _names):
        return []


@pytest.mark.parametrize(
    ("driver_name", "provider", "model", "api_format"),
    [
        ("anthropic", "minimax", "MiniMax-M3.1-Flash", "anthropic"),
        ("openai", "qwen", "qwen-max", "openai"),
        ("responses", "openai", "gpt-test", "responses"),
        ("ollama", "ollama", "llama-test", "openai"),
    ],
)
def test_primary_drivers_use_shared_five_minute_read_timeout(
    monkeypatch, driver_name, provider, model, api_format,
):
    from agent import providers
    from agent.context.assembly.area import MessageArea
    from agent.loop_drivers import AnthropicDriver, OllamaDriver, OpenAIDriver
    from agent.providers.openai_responses import OpenAIResponsesDriver
    from agent.tools import registry

    assert LLM_READ_TIMEOUT_SECONDS == 300.0

    captured_timeouts = []

    def capture_client(_ai, timeout):
        captured_timeouts.append(timeout)
        return object()

    monkeypatch.setattr(registry, "snapshot", lambda: _ToolSnapshot())
    monkeypatch.setattr(providers, "build_openai_client", capture_client)
    monkeypatch.setattr(providers, "build_anthropic_client", capture_client)
    monkeypatch.setattr(providers, "build_ollama_client", capture_client)
    monkeypatch.setattr(
        "agent.llm.llm_select.supports_anthropic_active_cache",
        lambda _ai: False,
    )

    ai = SimpleNamespace(
        provider=provider,
        model=model,
        base_url="https://provider.example/v1",
        api_key="test-key",
        api_format=api_format,
        max_tokens=256,
        thinking="disabled",
        reasoning_effort="",
        capability_overrides={},
        image=False,
        audio=False,
        video=False,
    )
    drivers = {
        "anthropic": AnthropicDriver,
        "openai": OpenAIDriver,
        "responses": OpenAIResponsesDriver,
        "ollama": OllamaDriver,
    }

    drivers[driver_name]().prepare(
        [], ai, MessageArea(), None, tool_snapshot=_ToolSnapshot(),
    )

    assert len(captured_timeouts) == 1
    timeout = captured_timeouts[0]
    assert timeout.read == LLM_READ_TIMEOUT_SECONDS
    assert timeout.connect == 10.0
    assert timeout.write == 10.0
    assert timeout.pool == 5.0
