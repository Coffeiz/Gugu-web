"""Provider 供应商适配层统一入口。

目录化后保留旧的 ``adapter_for``、``ProviderAdapter`` 和客户端构造函数入口，
调用方无需感知模块拆分。
"""
from __future__ import annotations

from copy import copy

from .anthropic import AnthropicAdapter
from .base import (
    MediaLimits, ProviderAdapter, ProviderCapabilities, ReasoningCapabilities,
    generic_thinking_params, generic_thinking_toggle_supported,
)
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


def _api_format_options(adapter, ai) -> dict[str, object]:
    supported = adapter.supported_api_formats(ai)
    user_selectable = adapter.name in {"local", "ollama"}
    selectable = (["native"] if adapter.name == "ollama" else []) + list(supported)
    urls = {}
    for api_format in selectable:
        updates = {"ollama_api_mode": "native"} if api_format == "native" else {"api_format": api_format}
        if adapter.name == "ollama" and api_format != "native":
            updates["ollama_api_mode"] = "openai"
        candidate = _copy_with_updates(ai, updates)
        urls[api_format] = adapter.default_base_url_for(candidate)
    return {
        "supported_api_formats": list(supported),
        "selectable_api_formats": selectable,
        "default_base_urls": urls,
        "default_api_format": "native" if adapter.name == "ollama" else adapter.capabilities(
            getattr(ai, "model", "") or "",
        ).api_format,
        "api_format_source": "user_selectable" if user_selectable else "provider_declared",
    }


def capability_snapshot(ai) -> dict[str, object]:
    """返回后台诊断可展示的静态能力声明。

    这里只读取适配器声明，不发请求、不修改配置；实际探测结果由后台探测接口
    单独返回，避免把一次性探测误当成运行时能力开关。
    """
    adapter = adapter_for(ai)
    model = getattr(ai, "model", "") or ""
    capabilities = adapter.capabilities(model)
    selected_api_format = adapter.protocol_format(ai)
    generic_thinking = generic_thinking_toggle_supported(ai, selected_api_format)
    reasoning = adapter.reasoning_capabilities(ai, selected_api_format)
    if generic_thinking:
        # 通用协议只提供开/关，不泄漏具体 Provider 的档位选项。
        reasoning = ReasoningCapabilities()
    overrides = getattr(ai, "capability_overrides", None) or {}
    values = {field: getattr(capabilities, field) for field in (
        "thinking", "structured_json", "structured_schema", "tools", "parallel_tools",
        "image", "audio", "video")}
    for field, value in overrides.items():
        if field in values and isinstance(value, bool):
            values[field] = value
    format_options = _api_format_options(adapter, ai)

    return {
        "provider": adapter.name,
        "model": model,
        "default_base_url": adapter.default_base_url_for(ai),
        "default_base_urls": format_options["default_base_urls"],
        "default_api_format": format_options["default_api_format"],
        "api_format": capabilities.api_format,
        "selected_api_format": selected_api_format,
        "supported_api_formats": format_options["supported_api_formats"],
        "selectable_api_formats": format_options["selectable_api_formats"],
        "api_format_source": format_options["api_format_source"],
        "reasoning_modes": list(reasoning.modes),
        "reasoning_efforts": list(reasoning.efforts),
        "supports_adaptive_thinking": reasoning.supports_adaptive_thinking,
        "generic_thinking_toggle_supported": generic_thinking,
        "cache_mode": capabilities.cache_mode,
        "thinking": values["thinking"],
        "structured_json": values["structured_json"],
        "structured_schema": values["structured_schema"],
        "tools": values["tools"],
        "parallel_tools": values["parallel_tools"],
        "image": values["image"],
        "audio": values["audio"],
        "video": values["video"],
        "overrides": {k: v for k, v in overrides.items() if k in values and isinstance(v, bool)},
    }


def filter_reasoning_config(ai):
    """返回只保留当前 Provider/模型/API 格式支持的推理配置副本。

    仅为当前请求过滤不适用于所选 Provider/协议的选项，不迁移或改写持久化配置。
    """
    adapter = adapter_for(ai)
    api_format = adapter.protocol_format(ai)
    if generic_thinking_toggle_supported(ai, api_format):
        return _filter_generic_thinking_config(ai)
    supported_formats = adapter.supported_api_formats(ai)
    reasoning = adapter.reasoning_capabilities(ai, api_format) \
        if api_format in supported_formats else None
    modes = set(reasoning.modes) if reasoning else set()
    efforts = set(reasoning.efforts) if reasoning else set()
    thinking = getattr(ai, "thinking", None)
    effort = getattr(ai, "reasoning_effort", None)
    updates = {}
    effort_is_supported = effort in efforts
    if thinking and thinking not in modes and not (thinking == "adaptive" and effort_is_supported and not modes):
        updates["thinking"] = None
    if effort and (not effort_is_supported or thinking == "disabled"):
        updates["reasoning_effort"] = ""
    if not updates:
        return ai
    return ai.model_copy(update=updates) if hasattr(ai, "model_copy") else _copy_with_updates(ai, updates)


def _filter_generic_thinking_config(ai):
    updates = {}
    if getattr(ai, "thinking", None) not in {None, "", "disabled", "adaptive"}:
        updates["thinking"] = None
    if getattr(ai, "reasoning_effort", None):
        updates["reasoning_effort"] = ""
    if not updates:
        return ai
    return ai.model_copy(update=updates) if hasattr(ai, "model_copy") else _copy_with_updates(ai, updates)


def _copy_with_updates(value, updates):
    cloned = copy(value)
    for key, item in updates.items():
        setattr(cloned, key, item)
    return cloned


def adapter_for(ai) -> ProviderAdapter:
    """按 provider 精确匹配，未命中时按 base_url 关键字兜底。"""
    provider = (getattr(ai, "provider", "") or "").lower()
    base_url = (getattr(ai, "base_url", "") or "").lower()
    # GLM Coding Plan 是独立接入类型：BYOK 以 glm + 专用地址保存，Admin
    # 也允许通过同一 Provider 的子类型选择，因此专用端点必须先于通用注册匹配。
    if provider in {"glm", "glm-coding"} and "bigmodel.cn" in base_url and "/api/coding/" in base_url:
        return _GLM_CODING
    if provider in _REGISTRY:
        return _REGISTRY[provider]
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
    from anthropic import AsyncAnthropic

    from app.core.credentials import normalize_ascii_api_key
    # 生产环境的新版 SDK 使用 httpx2；不能直接接收由 httpx 创建的
    # Timeout 对象，否则请求阶段会出现 float 与 Timeout 相加的 TypeError。
    if timeout is not None and not isinstance(timeout, (int, float)):
        timeout = getattr(timeout, "read", timeout)
    # max_retries=0：SDK 内建的立即重试收掉，退避节奏统一交给 app/core/retry.py
    # （否则应用层每次尝试内部还会偷偷打 3 发，过载窗口里全是无效请求）
    return AsyncAnthropic(
        api_key=normalize_ascii_api_key(getattr(ai, "api_key", "") or "dummy", label="模型 API Key"),
        base_url=adapter_for(ai).resolve_base_url(ai),
        timeout=timeout,
        max_retries=0,
        default_headers=adapter_for(ai).auth_headers(ai),
    )


def build_openai_client(ai, timeout):
    import httpx
    from openai import AsyncOpenAI

    adapter = adapter_for(ai)
    from app.core.credentials import normalize_ascii_api_key
    api_key = normalize_ascii_api_key(
        getattr(ai, "api_key", "") or ("ollama" if adapter.name == "ollama" else "dummy"),
        label="模型 API Key",
    )
    # 同上：SDK 内建重试收零，节奏统一在 app/core/retry.py
    return AsyncOpenAI(
        api_key=api_key,
        base_url=adapter.resolve_base_url(ai),
        timeout=timeout,
        max_retries=0,
        default_headers=adapter.auth_headers(ai),
    )


def build_ollama_client(ai, timeout):
    """构造原生 Ollama HTTP 客户端，避免把 NDJSON 塞进 OpenAI SDK。"""
    import httpx

    adapter = adapter_for(ai)
    if adapter.name != "ollama":
        raise ValueError("原生 Ollama 客户端只能用于 Ollama provider")
    from app.core.credentials import normalize_ascii_api_key
    api_key = normalize_ascii_api_key(getattr(ai, "api_key", "") or "ollama", label="模型 API Key")
    headers = {"Authorization": f"Bearer {api_key}"}
    headers.update(adapter.auth_headers(ai))
    return httpx.AsyncClient(timeout=timeout, headers=headers)


__all__ = [
    "MediaLimits", "ProviderAdapter", "ProviderCapabilities", "ReasoningCapabilities", "adapter_for",
    "capability_snapshot",
    "build_anthropic_client", "build_openai_client", "build_ollama_client",
]
