"""Provider 适配层测试（PRD-LLM-1 FR-LLM-4）。

重点钉死两件事：
1. `adapter_for()` 对已知 provider（minimax/mimo/deepseek）+ base_url 兜底识别的判定，
   跟改动前 `llm_select.py` 里各函数体的行为逐条对齐。
2. `transient_exceptions` 只对 MiniMax 生效——这次真正修的 bug（AttributeError）不能
   悄悄扩散到其它/未知 provider，误把无关 bug 也当"重试就好"吞掉。
"""
from types import SimpleNamespace

import pytest

from agent.providers import adapter_for, capability_snapshot


def _ai(provider: str = "", model: str = "", base_url: str = "") -> SimpleNamespace:
    return SimpleNamespace(provider=provider, model=model, base_url=base_url)


def test_adapter_for_minimax():
    a = adapter_for(_ai(provider="minimax", model="MiniMax-M3"))
    assert a.name == "minimax"
    assert a.api_format == "anthropic"
    assert IndexError in a.transient_exceptions
    assert KeyError in a.transient_exceptions
    assert AttributeError in a.transient_exceptions


def test_adapter_for_minimax_m2_vs_m3_cache():
    assert adapter_for(_ai(provider="minimax", model="MiniMax-M2.7")).supports_active_cache("MiniMax-M2.7")
    assert adapter_for(_ai(provider="minimax", model="MiniMax-M3")).supports_active_cache("MiniMax-M3")


def test_adapter_for_qwen_keeps_known_openai_cache_capability():
    a = adapter_for(_ai(provider="qwen", model="qwen-max"))
    assert a.name == "qwen"
    assert a.supports_active_cache("qwen-max")


def test_adapter_for_mimo_by_provider():
    a = adapter_for(_ai(provider="mimo"))
    assert a.name == "mimo"
    assert a.api_format == "openai"
    assert not a.supports_active_cache("")
    assert a.supports_thinking_toggle
    assert a.auth_headers(_ai(provider="mimo")) == {"api-key": ""}  # 始终带 key（api_key 空就是空串值，不是缺键）


def test_adapter_for_mimo_by_base_url_fallback():
    """未显式设置 provider，靠 base_url 关键字识别——对齐原 `_is_mimo` 的兜底口径。"""
    a = adapter_for(_ai(base_url="https://xiaomimimo.example.com/v1"))
    assert a.name == "mimo"


def test_adapter_for_mimo_auth_headers_uses_api_key():
    ai = SimpleNamespace(provider="mimo", api_key="sk-test-123")
    assert adapter_for(ai).auth_headers(ai) == {"api-key": "sk-test-123"}


def test_adapter_for_deepseek_by_provider():
    a = adapter_for(_ai(provider="deepseek"))
    assert a.name == "deepseek"
    assert a.api_format == "openai"
    assert a.supports_active_cache("")
    assert a.supports_thinking_toggle


def test_adapter_for_deepseek_by_base_url_fallback():
    a = adapter_for(_ai(base_url="https://api.deepseek.com/v1"))
    assert a.name == "deepseek"


def test_deepseek_vision_capability_is_limited_to_vision_model():
    adapter = adapter_for(_ai(provider="deepseek"))
    assert adapter.capabilities("deepseek-v4-flash-vision-exp").vision
    assert not adapter.capabilities("deepseek-v4-flash").vision


def test_deepseek_thinking_uses_official_openai_parameter_split():
    adapter = adapter_for(_ai(provider="deepseek"))
    ai = SimpleNamespace(provider="deepseek", thinking="adaptive", reasoning_effort="low")
    assert adapter.build_openai_thinking_kwargs(ai) == {
        "extra_body": {"thinking": {"type": "enabled"}},
        "reasoning_effort": "low",
    }
    assert adapter.build_openai_thinking_kwargs(
        SimpleNamespace(provider="deepseek", thinking="disabled", reasoning_effort="max")
    ) == {"extra_body": {"thinking": {"type": "disabled"}}}
    assert adapter.build_anthropic_thinking_params(ai) == {
        "thinking": {"type": "enabled"},
        "output_config": {"effort": "low"},
    }


def test_adapter_for_ollama_local_and_cloud_defaults():
    adapter = adapter_for(_ai(provider="ollama", model="qwen3:8b"))
    assert adapter.name == "ollama"
    assert adapter.api_format == "openai"
    assert adapter.resolve_base_url(SimpleNamespace(provider="ollama", base_url="")) == \
        "http://127.0.0.1:11434/api"
    assert adapter.resolve_base_url(SimpleNamespace(provider="ollama", base_url="", ollama_mode="cloud")) == \
        "https://ollama.com/api"


def test_ollama_openai_compatibility_keeps_v1_endpoint():
    adapter = adapter_for(_ai(provider="ollama"))
    assert adapter.resolve_base_url(SimpleNamespace(
        provider="ollama", base_url="", ollama_mode="local", ollama_api_mode="openai")) == \
        "http://127.0.0.1:11434/v1"


def test_ollama_native_request_builders():
    adapter = adapter_for(_ai(provider="ollama"))
    ai = SimpleNamespace(provider="ollama", model="qwen3:8b", api_key="", ollama_api_mode="native")
    assert adapter.diagnostic_request(ai)["path"] == "/chat"
    assert adapter.models_request(ai)["path"] == "/tags"


def test_adapter_for_ollama_by_local_base_url():
    assert adapter_for(_ai(base_url="http://127.0.0.1:11434/v1")).name == "ollama"


def test_ollama_openai_compatibility_parameters():
    adapter = adapter_for(_ai(provider="ollama"))
    assert adapter.build_thinking_params(SimpleNamespace(provider="ollama", thinking="disabled")) == {
        "reasoning_effort": "none"}
    assert adapter.build_thinking_params(SimpleNamespace(
        provider="ollama", thinking="adaptive", reasoning_effort="high")) == {
        "reasoning_effort": "high"}
    assert adapter.build_thinking_params(SimpleNamespace(
        provider="ollama", thinking="adaptive", reasoning_effort="unsupported")) == {
        "reasoning_effort": "medium"}
    assert adapter.build_structured_output(SimpleNamespace(provider="ollama")) == {
        "response_format": {"type": "json_object"}}


def test_local_runtime_defaults_and_conservative_capabilities():
    adapter = adapter_for(SimpleNamespace(provider="local", local_runtime="vllm", base_url=""))
    assert adapter.name == "local"
    assert adapter.resolve_base_url(SimpleNamespace(
        provider="local", local_runtime="vllm", base_url="")) == "http://127.0.0.1:8000/v1"
    assert adapter.capabilities("local-model").tools is False


def test_local_base_url_rejects_embedded_credentials_and_non_http():
    adapter = adapter_for(SimpleNamespace(provider="local"))
    with pytest.raises(ValueError):
        adapter.resolve_base_url(SimpleNamespace(provider="local", base_url="https://user:pass@example.test/v1"))
    with pytest.raises(ValueError):
        adapter.resolve_base_url(SimpleNamespace(provider="local", base_url="file:///tmp/model"))


def test_local_capability_override_is_exposed_without_credentials():
    snapshot = capability_snapshot(SimpleNamespace(
        provider="local", model="local-model", local_runtime="llama.cpp",
        capability_overrides={"tools": True, "structured_json": True}, api_key="secret"))
    assert snapshot["tools"] is True
    assert snapshot["structured_json"] is True
    assert snapshot["overrides"] == {"tools": True, "structured_json": True}
    assert "api_key" not in snapshot


def test_llama_cpp_enables_runtime_prompt_cache_without_active_provider_cache():
    adapter = adapter_for(_ai(provider="local"))
    llama = SimpleNamespace(provider="local", local_runtime="llama.cpp")
    vllm = SimpleNamespace(provider="local", local_runtime="vllm")

    assert adapter.build_openai_cache_kwargs(llama) == {
        "extra_body": {"cache_prompt": True}}
    assert adapter.build_openai_cache_kwargs(vllm) == {}
    assert not adapter.supports_active_cache("")


def test_adapter_for_unknown_provider_falls_back_to_default():
    """未命中任何已知 provider（既不是 minimax/mimo/deepseek，base_url 也没有对应关键字）
    → 退回 default 适配器。**关键断言**：transient_exceptions 为空——没有把 MiniMax 的
    AttributeError 容忍误扩散到未知/其它 provider。"""
    a = adapter_for(_ai(provider="anthropic"))
    assert a.name == "anthropic"
    assert a.transient_exceptions == ()
    assert AttributeError not in a.transient_exceptions


def test_adapter_for_truly_unknown_provider_also_falls_back_to_default():
    a = adapter_for(_ai(provider="some-other-openai-compatible-vendor"))
    assert a.name == "unknown"
    assert not a.supports_active_cache("")
    assert a.transient_exceptions == ()


def test_provider_capabilities_and_request_builders_are_model_scoped():
    mimo = adapter_for(_ai(provider="mimo"))
    deepseek = adapter_for(_ai(provider="deepseek"))
    qwen = adapter_for(_ai(provider="qwen", model="qwen3.5-flash"))

    assert mimo.capabilities().structured_json
    assert mimo.build_structured_output(_ai(provider="mimo")) == {
        "response_format": {"type": "json_object"}}
    assert deepseek.build_thinking_params(SimpleNamespace(provider="deepseek", thinking="disabled")) == {
        "thinking": {"type": "disabled"}}
    assert qwen.build_thinking_params(SimpleNamespace(provider="qwen", thinking="disabled")) == {}


def test_provider_media_and_stream_capabilities_are_centralized():
    mimo = adapter_for(_ai(provider="mimo"))
    minimax = adapter_for(_ai(provider="minimax", model="MiniMax-M3"))

    assert "mp3" in mimo.audio_native_exts()
    assert minimax.supports_video("MiniMax-M3")
    assert minimax.stream_sanitize_markers() == ("]<]minimax", "[e~[")


def test_capability_matrix_for_supported_providers_is_explicit():
    cases = {
        "anthropic": {"api_format": "anthropic", "cache_mode": "active", "tools": True},
        "qwen": {"api_format": "openai", "cache_mode": "active", "thinking": False,
                 "structured_json": False, "tools": True},
        "minimax": {"api_format": "anthropic", "cache_mode": "active", "tools": True},
        "mimo": {"api_format": "openai", "cache_mode": "none", "thinking": True,
                 "structured_json": True, "audio": True, "video": True},
        "deepseek": {"api_format": "openai", "cache_mode": "active", "thinking": True,
                     "structured_json": True, "tools": True},
        "ollama": {"api_format": "openai", "cache_mode": "none", "tools": True},
    }
    for provider, expected in cases.items():
        actual = capability_snapshot(_ai(provider=provider, model="MiniMax-M3" if provider == "minimax" else ""))
        for key, value in expected.items():
            assert actual[key] == value, (provider, key, actual)


def test_capability_snapshot_keeps_probe_separate_and_contains_no_credentials():
    ai = SimpleNamespace(provider="mimo", model="mimo-v2", api_key="secret-key")
    snapshot = capability_snapshot(ai)
    assert snapshot["provider"] == "mimo"
    assert snapshot["model"] == "mimo-v2"
    assert "api_key" not in snapshot
    assert "probe" not in snapshot


def test_request_snapshots_do_not_add_unsupported_provider_parameters():
    qwen = adapter_for(_ai(provider="qwen"))
    unknown = adapter_for(_ai(provider="some-other-openai-compatible-vendor"))
    ai = SimpleNamespace(provider="qwen", thinking="adaptive")
    assert qwen.build_thinking_params(ai) == {}
    assert qwen.build_structured_output(ai) == {}
    assert unknown.build_thinking_params(ai) == {}
    assert unknown.build_structured_output(ai) == {}
    assert unknown.build_tool_params(ai, []) == {}
    assert unknown.build_tool_params(ai, [{"type": "function", "function": {"name": "ping"}}]) == {
        "tools": [{"type": "function", "function": {"name": "ping"}}],
        "tool_choice": "auto",
    }


def test_diagnostic_request_builder_keeps_protocol_and_auth_provider_local():
    mimo = adapter_for(SimpleNamespace(provider="mimo"))
    anthropic = adapter_for(SimpleNamespace(provider="anthropic"))
    mimo_req = mimo.diagnostic_request(SimpleNamespace(provider="mimo", model="mimo-v2", api_key="k"))
    anthropic_req = anthropic.diagnostic_request(
        SimpleNamespace(provider="anthropic", model="claude-test", api_key="k"))
    assert mimo_req["path"] == "/chat/completions"
    assert mimo_req["headers"] == {"content-type": "application/json", "api-key": "k"}
    assert anthropic_req["path"] == "/messages"
    assert anthropic_req["headers"]["x-api-key"] == "k"
    assert anthropic_req["payload"]["model"] == "claude-test"


def test_models_request_builder_uses_provider_protocol_path():
    anthropic = adapter_for(SimpleNamespace(provider="anthropic"))
    openai = adapter_for(SimpleNamespace(provider="qwen"))
    assert anthropic.models_request(SimpleNamespace(
        provider="anthropic", base_url="https://api.anthropic.com", api_key="k"))["path"] == "/v1/models"
    assert openai.models_request(SimpleNamespace(
        provider="qwen", base_url="https://dashscope.example/v1", api_key="k"))["path"] == "/models"
