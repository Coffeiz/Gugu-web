"""Provider 供应商适配层统一入口。

目录化后保留旧的 ``adapter_for``、``ProviderAdapter`` 和客户端构造函数入口，
调用方无需感知模块拆分。
"""
from __future__ import annotations

from .anthropic import AnthropicAdapter
from .base import MediaLimits, ProviderAdapter, ProviderCapabilities
from .deepseek import DeepSeekAdapter
from .glm import GlmAdapter, GlmCodingAdapter
from .mimo import MimoAdapter
from .minimax import MiniMaxAdapter
from .openai import OpenAIAdapter
from .ollama import OllamaAdapter
from .local import LocalAdapter
from .qwen import QwenAdapter

_DEFAULT = OpenAIAdapter()
_ANTHROPIC = AnthropicAdapter()
_QWEN = QwenAdapter()
_MINIMAX = MiniMaxAdapter()
_MIMO = MimoAdapter()
_DEEPSEEK = DeepSeekAdapter()
_GLM = GlmAdapter()
_GLM_CODING = GlmCodingAdapter()
_OLLAMA = OllamaAdapter()
_LOCAL = LocalAdapter()

_REGISTRY: dict[str, ProviderAdapter] = {
    "anthropic": _ANTHROPIC,
    "qwen": _QWEN,
    "minimax": _MINIMAX,
    "mimo": _MIMO,
    "deepseek": _DEEPSEEK,
    "glm": _GLM,
    "glm-coding": _GLM_CODING,
    "ollama": _OLLAMA,
    "local": _LOCAL,
}


def capability_snapshot(ai) -> dict[str, object]:
    """返回后台诊断可展示的静态能力声明。

    这里只读取适配器声明，不发请求、不修改配置；实际探测结果由后台探测接口
    单独返回，避免把一次性探测误当成运行时能力开关。
    """
    adapter = adapter_for(ai)
    model = getattr(ai, "model", "") or ""
    capabilities = adapter.capabilities(model)
    overrides = getattr(ai, "capability_overrides", None) or {}
    values = {field: getattr(capabilities, field) for field in (
        "thinking", "structured_json", "structured_schema", "tools", "parallel_tools",
        "vision", "audio", "video")}
    for field, value in overrides.items():
        if field in values and isinstance(value, bool):
            values[field] = value
    return {
        "provider": adapter.name,
        "model": model,
        "api_format": capabilities.api_format,
        "cache_mode": capabilities.cache_mode,
        "thinking": values["thinking"],
        "structured_json": values["structured_json"],
        "structured_schema": values["structured_schema"],
        "tools": values["tools"],
        "parallel_tools": values["parallel_tools"],
        "vision": values["vision"],
        "audio": values["audio"],
        "video": values["video"],
        "overrides": {k: v for k, v in overrides.items() if k in values and isinstance(v, bool)},
    }


def adapter_for(ai) -> ProviderAdapter:
    """按 provider 精确匹配，未命中时按 base_url 关键字兜底。"""
    provider = (getattr(ai, "provider", "") or "").lower()
    if provider in _REGISTRY:
        return _REGISTRY[provider]
    base_url = (getattr(ai, "base_url", "") or "").lower()
    if "xiaomimimo" in base_url:
        return _MIMO
    if "minimaxi.com" in base_url:
        return _MINIMAX
    if "deepseek" in base_url:
        return _DEEPSEEK
    if "bigmodel.cn" in base_url and "/api/coding/" in base_url:
        return _GLM_CODING
    if "bigmodel.cn" in base_url:
        return _GLM
    if "ollama" in base_url or "11434" in base_url:
        return _OLLAMA
    return _DEFAULT


def build_anthropic_client(ai, timeout):
    import httpx
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(
        api_key=getattr(ai, "api_key", "") or "dummy",
        base_url=adapter_for(ai).resolve_base_url(ai),
        http_client=httpx.AsyncClient(timeout=timeout),
        default_headers=adapter_for(ai).auth_headers(ai),
    )


def build_openai_client(ai, timeout):
    import httpx
    from openai import AsyncOpenAI

    adapter = adapter_for(ai)
    api_key = getattr(ai, "api_key", "") or ("ollama" if adapter.name == "ollama" else "dummy")
    return AsyncOpenAI(
        api_key=api_key,
        base_url=adapter.resolve_base_url(ai),
        timeout=timeout,
        default_headers=adapter.auth_headers(ai),
    )


def build_ollama_client(ai, timeout):
    """构造原生 Ollama HTTP 客户端，避免把 NDJSON 塞进 OpenAI SDK。"""
    import httpx

    adapter = adapter_for(ai)
    if adapter.name != "ollama":
        raise ValueError("原生 Ollama 客户端只能用于 Ollama provider")
    api_key = getattr(ai, "api_key", "") or "ollama"
    headers = {"Authorization": f"Bearer {api_key}"}
    headers.update(adapter.auth_headers(ai))
    return httpx.AsyncClient(timeout=timeout, headers=headers)


__all__ = [
    "MediaLimits", "ProviderAdapter", "ProviderCapabilities", "adapter_for",
    "capability_snapshot",
    "build_anthropic_client", "build_openai_client", "build_ollama_client",
]
