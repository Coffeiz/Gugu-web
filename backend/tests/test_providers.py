"""Provider 适配层测试（PRD-LLM-1 FR-LLM-4）。

重点钉死两件事：
1. `adapter_for()` 对已知 provider（minimax/mimo/deepseek）+ base_url 兜底识别的判定，
   跟改动前 `llm_select.py` 里各函数体的行为逐条对齐。
2. `transient_exceptions` 只对 MiniMax 生效——这次真正修的 bug（AttributeError）不能
   悄悄扩散到其它/未知 provider，误把无关 bug 也当"重试就好"吞掉。
"""
from types import SimpleNamespace

from agent.providers import adapter_for


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
    assert not adapter_for(_ai(provider="minimax", model="MiniMax-M3")).supports_active_cache("MiniMax-M3")


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
