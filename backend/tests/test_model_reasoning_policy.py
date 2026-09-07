"""模型级推理状态策略回归。"""
from types import SimpleNamespace

from agent.llm.llm_select import resolve_run_config


def _settings(mode: str):
    model = SimpleNamespace(
        provider="openai",
        api_format="",
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
