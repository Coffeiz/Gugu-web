from types import SimpleNamespace

from agent.llm.llm_select import supports_anthropic_active_cache, supports_openai_active_cache


def _model(provider: str, model: str, base_url: str = "") -> SimpleNamespace:
    return SimpleNamespace(provider=provider, model=model, base_url=base_url)


def test_minimax_m3_uses_active_cache() -> None:
    # 实测主动/被动缓存效果无明显差异，统一走主动缓存并保留可观测命中数。
    assert supports_anthropic_active_cache(_model("minimax", "MiniMax-M3"))


def test_minimax_m2_keeps_anthropic_active_cache() -> None:
    assert supports_anthropic_active_cache(_model("minimax", "MiniMax-M2.7"))


def test_mimo_does_not_receive_anthropic_cache_control() -> None:
    assert not supports_anthropic_active_cache(_model("mimo", "MiMo-V2"))


def test_anthropic_provider_keeps_existing_active_cache_behavior() -> None:
    assert supports_anthropic_active_cache(_model("anthropic", "claude-sonnet"))


def test_openai_compatible_qwen_uses_active_cache() -> None:
    assert supports_openai_active_cache(_model("qwen", "qwen3.5-flash"))


def test_openai_mimo_skips_active_cache() -> None:
    assert not supports_openai_active_cache(_model("mimo", "MiMo-V2"))
