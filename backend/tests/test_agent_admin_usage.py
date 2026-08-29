from app.api.v1.agent_admin import _SPLIT_CACHE_PROVIDERS, _effective_input_tokens


def test_split_cache_provider_list_covers_anthropic_compatible_usage():
    assert _SPLIT_CACHE_PROVIDERS == ("anthropic", "minimax")


def test_effective_input_tokens_uses_full_input_for_split_cache_usage():
    assert _effective_input_tokens("anthropic", 100, 700, 20) == 820
    assert _effective_input_tokens("minimax", 100, 700, 20) == 820
    assert _effective_input_tokens("deepseek", 800, 700, 20) == 800
