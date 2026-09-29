"""Provider 适配层测试（PRD-LLM-1 FR-LLM-4）。

重点钉死两件事：
1. `adapter_for()` 对已知 provider（minimax/mimo/deepseek）+ base_url 兜底识别的判定，
   跟改动前 `llm_select.py` 里各函数体的行为逐条对齐。
2. `transient_exceptions` 只对 MiniMax 生效——这次真正修的 bug（AttributeError）不能
   悄悄扩散到其它/未知 provider，误把无关 bug 也当"重试就好"吞掉。
"""
from types import SimpleNamespace

import pytest

from agent.providers import adapter_for, capability_snapshot, filter_reasoning_config


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
    assert a.protocol_format(_ai(provider="qwen", base_url="https://example.com/anthropic")) == "openai"
    assert adapter_for(_ai(provider="openai")).protocol_format(
        _ai(provider="openai", base_url="https://example.com/anthropic")) == "openai"
    assert a.name == "qwen"
    assert a.supports_active_cache("qwen-max")


def test_responses_prompt_cache_key_is_official_openai_only():
    adapter = adapter_for(_ai(provider="openai", base_url="https://api.openai.com/v1"))
    assert adapter.supports_responses_prompt_cache_key(
        _ai(provider="openai", base_url="https://api.openai.com/v1")
    )
    assert not adapter.supports_responses_prompt_cache_key(
        _ai(provider="openai", base_url="https://gateway.example.com/v1")
    )
    assert not adapter_for(_ai(provider="qwen")).supports_responses_prompt_cache_key(
        _ai(provider="qwen")
    )


def test_bailian_qwen3_capabilities_and_thinking_toggle():
    adapter = adapter_for(_ai(provider="qwen", model="qwen3.8-max"))
    assert adapter.capabilities("qwen3.8-max").thinking
    assert adapter.capabilities("qwen3.8-max").structured_json
    assert adapter.capabilities("qwen3.8-max").structured_schema
    assert adapter.supported_api_formats(SimpleNamespace(
        provider="qwen", model="qwen3.8-max"
    )) == ("openai", "responses")
    assert adapter.reasoning_capabilities(SimpleNamespace(
        provider="qwen", model="qwen3.8-max"
    ), "responses").efforts == (
        "none", "minimal", "low", "medium", "high", "xhigh", "max")
    assert adapter.build_responses_reasoning_params(SimpleNamespace(
        provider="qwen", model="qwen3.8-max", thinking="disabled", reasoning_effort="high"
    )) == {"reasoning": {"effort": "none"}}
    assert adapter.supports_explicit_cache("qwen3.6-flash")
    assert adapter.uses_single_history_cache_anchor("qwen3.6-flash")
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="qwen", model="qwen3.8-max", thinking="disabled"
    )) == {"extra_body": {"enable_thinking": False}}
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="qwen", model="qwen3.8-max", thinking="adaptive"
    )) == {"extra_body": {"preserve_thinking": True}}
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="qwen", model="qwen3.8-max", thinking="adaptive", reasoning_effort="high"
    )) == {
        "extra_body": {"preserve_thinking": True}, "reasoning_effort": "xhigh"
    }
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="qwen", model="qwen3.8-max", thinking="adaptive", reasoning_effort="none"
    )) == {"extra_body": {"enable_thinking": False}}
    assert adapter.build_structured_output(SimpleNamespace(
        provider="qwen", model="qwen3.8-max"
    ), {"type": "object"}) == {
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "gugu_output", "schema": {"type": "object"}},
        }
    }


def test_bailian_legacy_qwen_does_not_receive_qwen3_parameters():
    adapter = adapter_for(_ai(provider="qwen", model="qwen-max"))
    ai = SimpleNamespace(provider="qwen", model="qwen-max", thinking="disabled")
    assert adapter.build_thinking_params(ai) == {}
    assert adapter.build_structured_output(ai) == {}


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
    assert not a.supports_explicit_cache("")
    assert a.supports_thinking_toggle


def test_unknown_openai_compatible_provider_uses_explicit_history_cache():
    adapter = adapter_for(_ai(provider="some-other-openai-compatible-vendor"))
    assert adapter.supports_active_cache("")
    assert adapter.supports_explicit_cache("")


def test_adapter_for_glm_uses_openai_compatible_endpoint():
    adapter = adapter_for(_ai(provider="glm", model="glm-5.2"))
    assert adapter.name == "glm"
    assert adapter.api_format == "openai"
    assert adapter.resolve_base_url(SimpleNamespace(provider="glm", base_url="")) == \
        "https://open.bigmodel.cn/api/paas/v4"
    assert adapter.capabilities("glm-5.2").thinking
    assert adapter.capabilities("glm-5.2").tools
    assert not adapter.supports_active_cache("glm-5.2")


def test_old_reasoning_values_are_ignored_when_current_model_format_does_not_support_them():
    old_generic = SimpleNamespace(
        provider="custom-compatible", model="private-model", base_url="https://gateway.example/v1",
        api_format="openai", thinking="adaptive", reasoning_effort="high",
    )
    filtered = filter_reasoning_config(old_generic)
    assert filtered is not old_generic
    assert filtered.thinking is None
    assert filtered.reasoning_effort == ""
    assert old_generic.thinking == "adaptive"  # 旧配置对象不被原地修改


def test_supported_reasoning_effort_requires_adaptive_mode():
    disabled = SimpleNamespace(
        provider="deepseek", model="deepseek-v4-flash", base_url="https://api.deepseek.com",
        api_format="openai", thinking="disabled", reasoning_effort="high",
    )
    filtered = filter_reasoning_config(disabled)
    assert filtered.reasoning_effort == ""
    assert adapter_for(filtered).build_openai_thinking_kwargs(filtered) == {
        "extra_body": {"thinking": {"type": "disabled"}},
    }


def test_unknown_model_capability_snapshot_offers_default_without_reasoning_controls():
    snapshot = capability_snapshot(SimpleNamespace(
        provider="qwen", model="qwen-max", base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_format="openai",
    ))
    assert snapshot["supported_api_formats"] == ["openai"]
    assert snapshot["reasoning_modes"] == []
    assert snapshot["reasoning_efforts"] == []


def test_glm_53_protocols_effort_and_protocol_specific_endpoints():
    adapter = adapter_for(_ai(provider="glm", model="glm-5.3"))
    assert adapter.supported_api_formats(SimpleNamespace(
        provider="glm", model="glm-5.3", api_format="openai"
    )) == ("openai", "responses", "anthropic")
    assert adapter.resolve_base_url(SimpleNamespace(
        provider="glm", model="glm-5.3", api_format="responses", base_url=""
    )) == "https://open.bigmodel.cn/api/v1"
    assert adapter.resolve_base_url(SimpleNamespace(
        provider="glm", model="glm-5.3", api_format="anthropic", base_url=""
    )) == "https://open.bigmodel.cn/api/anthropic"
    ai = SimpleNamespace(
        provider="glm", model="glm-5.3", api_format="openai",
        thinking="disabled", reasoning_effort="high",
    )
    assert adapter.reasoning_capabilities(ai, "openai").modes == ("adaptive",)
    assert adapter.build_openai_thinking_kwargs(ai) == {}
    ai.api_format = "responses"
    assert adapter.reasoning_capabilities(ai, "responses").efforts == ()
    assert adapter.build_responses_reasoning_params(ai) == {}
    coding = adapter_for(_ai(provider="glm-coding", model="glm-5.3"))
    assert coding.supported_api_formats(SimpleNamespace(
        provider="glm-coding", model="glm-5.3"
    )) == ("openai",)


def test_glm_thinking_parameters_are_model_scoped():
    adapter = adapter_for(_ai(provider="glm"))
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="glm", model="glm-5.2", thinking="adaptive"
    )) == {"extra_body": {"thinking": {"type": "enabled"}}}
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="glm", model="glm-5.2", thinking="disabled"
    )) == {"extra_body": {"thinking": {"type": "disabled"}}}
    assert adapter.build_thinking_params(SimpleNamespace(
        provider="glm", model="glm-4-air", thinking="adaptive"
    )) == {}


def test_adapter_for_glm_by_base_url_fallback():
    assert adapter_for(_ai(base_url="https://open.bigmodel.cn/api/paas/v4")).name == "glm"


def test_adapter_for_glm_coding_plan_uses_dedicated_endpoint():
    adapter = adapter_for(_ai(provider="glm-coding", model="glm-5.2"))
    assert adapter.name == "glm-coding"
    assert adapter.resolve_base_url(SimpleNamespace(provider="glm-coding", base_url="")) == \
        "https://open.bigmodel.cn/api/coding/paas/v4"
    assert adapter.capabilities("glm-5.2").tools
    assert not adapter.capabilities("glm-5.2").image
    assert adapter_for(_ai(base_url="https://open.bigmodel.cn/api/coding/paas/v4")).name == "glm-coding"


def test_cache_capabilities_are_separate_by_provider():
    deepseek = adapter_for(_ai(provider="deepseek", model="deepseek-chat")).cache_capabilities("deepseek-chat")
    qwen = adapter_for(_ai(provider="qwen", model="qwen3.6-flash")).cache_capabilities("qwen3.6-flash")
    minimax = adapter_for(_ai(provider="minimax", model="MiniMax-M3")).cache_capabilities("MiniMax-M3")
    assert deepseek.automatic_prefix_cache and not deepseek.explicit_cache_control
    assert qwen.automatic_prefix_cache and qwen.explicit_cache_control and qwen.single_history_anchor
    assert minimax.automatic_prefix_cache


def test_adapter_for_deepseek_by_base_url_fallback():
    a = adapter_for(_ai(base_url="https://api.deepseek.com/v1"))
    assert a.name == "deepseek"


def test_deepseek_vision_capability_includes_current_and_legacy_vision_models():
    adapter = adapter_for(_ai(provider="deepseek"))
    assert adapter.capabilities("deepseek-flash").image
    assert adapter.capabilities("deepseek-v4-flash-vision-exp").image
    assert not adapter.capabilities("deepseek-v4-flash").image
    assert not adapter.capabilities("deepseek-chat").image


def test_deepseek_thinking_uses_official_openai_parameter_split():
    adapter = adapter_for(_ai(provider="deepseek"))
    ai = SimpleNamespace(
        provider="deepseek", model="deepseek-flash", thinking="adaptive", reasoning_effort="low"
    )
    assert adapter.supported_api_formats(ai) == ("openai", "responses", "anthropic")
    assert adapter.reasoning_capabilities(ai, "responses").provider_effort("xhigh") == "high"
    assert adapter.default_base_url_for(SimpleNamespace(
        provider="deepseek", model="deepseek-flash", api_format="anthropic", base_url=""
    )) == "https://api.deepseek.com/anthropic"
    assert adapter.build_openai_thinking_kwargs(ai) == {
        "extra_body": {"thinking": {"type": "enabled"}},
        "reasoning_effort": "low",
    }
    assert adapter.build_openai_thinking_kwargs(
        SimpleNamespace(provider="deepseek", model="deepseek-flash", thinking="disabled",
                        reasoning_effort="max")
    ) == {"extra_body": {"thinking": {"type": "disabled"}}}
    ai.api_format = "anthropic"
    assert adapter.build_anthropic_thinking_params(ai) == {
        "thinking": {"type": "enabled"},
        "output_config": {"effort": "low"},
    }
    ai.thinking = "disabled"
    assert adapter.build_anthropic_thinking_params(ai) == {
        "reasoning": {"effort": "none"}}


def test_minimax_temperature_is_not_sent_at_all():
    # Anthropic SDK 1.x 不再接受额外的顶层采样参数，MiniMax 也不应通过 extra_body 携带。
    adapter = adapter_for(_ai(provider="minimax"))
    assert adapter.build_anthropic_generation_params(SimpleNamespace()) == {}


def test_anthropic_temperature_is_not_sent_to_sdk_stream():
    adapter = adapter_for(_ai(provider="anthropic"))
    assert adapter.build_anthropic_generation_params(SimpleNamespace()) == {}


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
    assert adapter.build_thinking_params(SimpleNamespace(provider="ollama", ollama_api_mode="openai", thinking="disabled")) == {
        "reasoning_effort": "none"}
    assert adapter.build_thinking_params(SimpleNamespace(
        provider="ollama", ollama_api_mode="openai", thinking="adaptive", reasoning_effort="high")) == {
        "reasoning_effort": "high"}
    assert adapter.build_thinking_params(SimpleNamespace(
        provider="ollama", ollama_api_mode="openai", thinking="adaptive", reasoning_effort="unsupported")) == {
        "reasoning_effort": "medium"}
    assert adapter.build_openai_thinking_kwargs(SimpleNamespace(
        provider="ollama", model="qwen3:8b", ollama_api_mode="openai",
        thinking="adaptive", reasoning_effort="high")) == {
        "extra_body": {"reasoning_effort": "high"}}
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
    assert a.supports_active_cache("")
    assert a.supports_explicit_cache("")
    assert a.transient_exceptions == ()


def test_provider_capabilities_and_request_builders_are_model_scoped():
    mimo = adapter_for(_ai(provider="mimo"))
    deepseek = adapter_for(_ai(provider="deepseek"))
    qwen = adapter_for(_ai(provider="qwen", model="qwen3.5-flash"))

    assert mimo.capabilities().structured_json
    assert mimo.build_structured_output(_ai(provider="mimo")) == {
        "response_format": {"type": "json_object"}}
    assert deepseek.build_thinking_params(SimpleNamespace(
        provider="deepseek", model="deepseek-flash", thinking="disabled"
    )) == {"thinking": {"type": "disabled"}}
    assert deepseek.build_thinking_params(SimpleNamespace(
        provider="deepseek", model="deepseek-chat", thinking="disabled"
    )) == {}
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
        "deepseek": {"api_format": "openai", "cache_mode": "active", "thinking": False,
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


def test_reasoning_capabilities_are_model_and_api_format_scoped():
    openai = adapter_for(_ai(provider="openai", model="gpt-5.6-sol"))
    openai_ai = SimpleNamespace(
        provider="openai", model="gpt-5.6-sol", api_format="openai",
        reasoning_effort="max",
    )
    assert openai.supported_api_formats(openai_ai) == ("openai", "responses")
    assert openai.reasoning_capabilities(openai_ai, "openai").efforts == (
        "none", "low", "medium", "high", "xhigh", "max")
    assert openai.build_openai_thinking_kwargs(openai_ai) == {"reasoning_effort": "max"}
    assert openai.build_responses_reasoning_params(openai_ai) == {
        "reasoning": {"effort": "max"}}


def test_compatible_endpoints_do_not_inherit_official_provider_reasoning_options():
    openai = adapter_for(_ai(provider="openai", model="gpt-5.6-sol", base_url="https://gateway.example/v1"))
    openai_ai = SimpleNamespace(
        provider="openai", model="gpt-5.6-sol", base_url="https://gateway.example/v1",
        api_format="openai", thinking="adaptive", reasoning_effort="high",
    )
    assert openai.reasoning_capabilities(openai_ai, "openai").efforts == ()
    assert filter_reasoning_config(openai_ai).reasoning_effort == ""
    anthropic = adapter_for(_ai(provider="anthropic", model="claude-opus-4-8", base_url="https://proxy.example/v1"))
    anthropic_ai = SimpleNamespace(
        provider="anthropic", model="claude-opus-4-8", base_url="https://proxy.example/v1",
        api_format="anthropic", thinking="adaptive", reasoning_effort="high",
    )
    assert anthropic.reasoning_capabilities(anthropic_ai, "anthropic").modes == ()
    filtered = filter_reasoning_config(anthropic_ai)
    assert filtered.thinking is None
    assert filtered.reasoning_effort == ""

    chat_only = SimpleNamespace(
        provider="openai", model="gpt-5.5-pro", api_format="responses",
        reasoning_effort="high",
    )
    assert openai.supported_api_formats(chat_only) == ("responses",)
    assert openai.reasoning_capabilities(chat_only, "openai").efforts == ()

    unsupported = SimpleNamespace(
        provider="openai", model="gpt-4o", api_format="responses", reasoning_effort="high",
    )
    assert openai.build_responses_reasoning_params(unsupported) == {}


def test_anthropic_and_minimax_efforts_use_anthropic_wire_parameters():
    anthropic = adapter_for(_ai(provider="anthropic", model="claude-opus-4-8"))
    claude_ai = SimpleNamespace(
        provider="anthropic", model="claude-opus-4-8", api_format="anthropic",
        thinking="adaptive", reasoning_effort="xhigh",
    )
    assert anthropic.build_anthropic_thinking_params(claude_ai) == {
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "xhigh"},
    }
    assert anthropic.build_anthropic_thinking_params(SimpleNamespace(
        provider="anthropic", model="claude-sonnet-4-5", thinking="adaptive",
        reasoning_effort="high",
    )) == {}

    minimax = adapter_for(_ai(provider="minimax", model="MiniMax-M3.1-Flash-Preview"))
    minimax_ai = SimpleNamespace(
        provider="minimax", model="MiniMax-M3.1-Flash-Preview", api_format="anthropic",
        thinking="adaptive", reasoning_effort="xhigh",
    )
    assert minimax.capabilities(minimax_ai.model).thinking
    assert minimax.reasoning_capabilities(minimax_ai, "anthropic").efforts == (
        "low", "medium", "high", "xhigh", "max")
    assert minimax.build_anthropic_thinking_params(minimax_ai) == {
        "output_config": {"effort": "xhigh"}}
    minimax_ai.reasoning_effort = "minimal"
    assert minimax.build_anthropic_thinking_params(minimax_ai) == {}


def test_deepseek_effort_aliases_are_shared_across_chat_and_responses_contracts():
    adapter = adapter_for(_ai(provider="deepseek", model="deepseek-v4-flash"))
    ai = SimpleNamespace(
        provider="deepseek", model="deepseek-v4-flash", thinking="adaptive",
        reasoning_effort="xhigh",
    )
    assert adapter.build_openai_thinking_kwargs(ai) == {
        "extra_body": {"thinking": {"type": "enabled"}},
        "reasoning_effort": "high",
    }
    ai.api_format = "responses"
    assert adapter.build_responses_reasoning_params(ai) == {
        "reasoning": {"effort": "high"}}
    ai.thinking = "disabled"
    assert adapter.build_responses_reasoning_params(ai) == {
        "reasoning": {"effort": "none"}}


def test_capability_snapshot_exposes_protocol_scoped_reasoning_options():
    snapshot = capability_snapshot(SimpleNamespace(
        provider="minimax", model="MiniMax-M3.1-Flash-Preview", api_format="anthropic",
    ))
    assert snapshot["selected_api_format"] == "anthropic"
    assert snapshot["default_api_format"] == "anthropic"
    assert snapshot["default_base_url"] == "https://api.minimaxi.com/anthropic"
    assert snapshot["supported_api_formats"] == ["anthropic"]
    assert snapshot["reasoning_modes"] == ["adaptive"]
    assert snapshot["reasoning_efforts"] == ["low", "medium", "high", "xhigh", "max"]


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


def test_diagnostic_request_expands_openai_provider_extra_body():
    qwen = adapter_for(SimpleNamespace(provider="qwen"))
    request = qwen.diagnostic_request(SimpleNamespace(
        provider="qwen", model="qwen3.8-max", api_key="k", thinking="disabled"
    ))
    assert request["payload"]["enable_thinking"] is False


def test_models_request_builder_uses_provider_protocol_path():
    anthropic = adapter_for(SimpleNamespace(provider="anthropic"))
    openai = adapter_for(SimpleNamespace(provider="qwen"))
    assert anthropic.models_request(SimpleNamespace(
        provider="anthropic", base_url="https://api.anthropic.com", api_key="k"))["path"] == "/v1/models"
    assert openai.models_request(SimpleNamespace(
        provider="qwen", base_url="https://dashscope.example/v1", api_key="k"))["path"] == "/models"
