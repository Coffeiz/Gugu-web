"""供应商适配器基类与共享能力模型。

这里仅描述「如何调用模型」的差异，不承载选模、工具循环或业务流程。
旧版 ProviderAdapter 的公开属性和方法保留，便于目录化迁移期间零行为变化。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ProviderCapabilities:
    """按模型声明的能力矩阵。

    供应商适配器可以按 model 覆盖，避免把同一供应商的所有模型误认为能力相同。
    """

    api_format: Literal["anthropic", "openai"]
    cache_mode: str = "none"
    thinking: bool = False
    structured_json: bool = False
    structured_schema: bool = False
    tools: bool = True
    parallel_tools: bool = False
    vision: bool = False
    audio: bool = False
    video: bool = False


class ProviderAdapter:
    """单个供应商/模型族的调用差异。

    兼容旧 API：调用方仍可读取 ``api_format``、``supports_thinking_toggle``、
    ``cache_mode``，并调用 ``supports_active_cache(model)`` 与 ``auth_headers(ai)``。
    """

    name = "unknown"
    api_format: Literal["anthropic", "openai"] = "anthropic"
    default_base_url = ""
    cache_mode = "active"
    supports_thinking_toggle = False
    transient_exceptions: tuple[type[BaseException], ...] = ()

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format=self.api_format, cache_mode=self.cache_mode,
                                    thinking=self.supports_thinking_toggle)

    def supports_active_cache(self, model: str = "") -> bool:
        return self.capabilities(model).cache_mode == "active"

    def supports_explicit_cache(self, model: str = "") -> bool:
        """是否在 OpenAI-compatible 请求中尝试发送显式缓存锚点。

        未声明专属拒绝行为的兼容端点默认忽略未知 content 字段，因此统一尝试
        发送；真正的命中与计费仍以 provider 返回的 usage 为准。
        """
        return True

    def cache_capabilities(self, model: str = ""):
        """返回统一缓存能力描述，具体策略仍由现有驱动决定。"""
        from agent.context.cache_policy import cache_capabilities
        return cache_capabilities(self, model)

    def render_history(self, messages):
        """把 canonical history 转换为本 provider 的请求前历史。"""
        from agent.context.canonical_tool_history import render_events_for_provider
        return render_events_for_provider(messages)

    def uses_single_history_cache_anchor(self, model: str = "") -> bool:
        """是否只发送一个最新的历史缓存锚点。

        不同 OpenAI 兼容端点对多个显式锚点的实现并不一致；默认保持历史
        行为，由具体 provider 按实测能力覆盖。
        """
        return False

    def auth_headers(self, ai) -> dict[str, str]:
        return {}

    def resolve_base_url(self, ai) -> str:
        """返回本次请求地址；允许本地服务使用默认地址而不保存伪造配置。"""
        return (getattr(ai, "base_url", "") or self.default_base_url).rstrip("/")

    def diagnostic_request(self, ai) -> dict:
        """构造后台连通性测试请求，不执行请求也不返回密钥。"""
        protocol = self.protocol_format(ai)
        api_key = getattr(ai, "api_key", "") or ("ollama" if self.name == "ollama" else "")
        if protocol == "anthropic":
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01",
                       "content-type": "application/json"}
            path = "/messages"
            payload = {"model": getattr(ai, "model", ""), "max_tokens": 1,
                       "messages": [{"role": "user", "content": "hi"}]}
        else:
            headers = {"content-type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            path = "/chat/completions"
            payload = {"model": getattr(ai, "model", ""), "max_tokens": 1,
                       "messages": [{"role": "user", "content": "hi"}]}
            # 后台探测必须和正式 OpenAI SDK 调用复用同一套 provider 专属参数。
            # SDK 的 extra_body 会被展开到请求体；这里是原始 HTTP，所以显式合并。
            for key, value in self.build_openai_thinking_kwargs(ai).items():
                if key == "extra_body" and isinstance(value, dict):
                    payload.update(value)
                else:
                    payload[key] = value
        headers.update(self.auth_headers(ai))
        if self.name == "mimo":
            headers.pop("Authorization", None)
        return {"path": path, "headers": headers, "payload": payload}

    def models_request(self, ai) -> dict:
        """构造后台模型列表请求，统一协议路径和鉴权头。"""
        protocol = self.protocol_format(ai)
        base_url = self.resolve_base_url(ai)
        path = "/models" if protocol == "openai" or base_url.endswith("/v1") else "/v1/models"
        headers = {"Accept": "application/json"}
        api_key = getattr(ai, "api_key", "") or ("ollama" if self.name == "ollama" else "")
        if protocol == "anthropic":
            headers["anthropic-version"] = "2023-06-01"
            if api_key:
                headers["x-api-key"] = api_key
        else:
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
        headers.update(self.auth_headers(ai))
        if self.name == "mimo":
            headers.pop("Authorization", None)
        return {"path": path, "headers": headers}

    def stream_sanitize_markers(self) -> tuple[str, ...]:
        return ()

    def audio_native_exts(self) -> frozenset[str]:
        return frozenset()

    def supports_video(self, model: str = "") -> bool:
        return self.capabilities(model).video

    def supports_audio(self, model: str = "") -> bool:
        return self.capabilities(model).audio

    def protocol_format(self, ai) -> Literal["anthropic", "openai"]:
        """解析本次请求使用的协议格式，集中处理显式配置和地址兼容规则。"""
        configured = (getattr(ai, "api_format", "") or "").lower()
        if configured in ("anthropic", "openai"):
            return configured
        if self.name in ("anthropic", "minimax"):
            return "anthropic"
        if "anthropic" in (getattr(ai, "base_url", "") or "").lower():
            return "anthropic"
        return "openai"

    def media_transport(self, model: str = "") -> str:
        """返回媒体 payload 应使用的协议：none/openai/anthropic。"""
        if not self.supports_video(model):
            return "none"
        return "anthropic" if self.capabilities(model).api_format == "anthropic" else "openai"

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        """返回供应商需要附加到请求的 thinking 参数；默认不附加。"""
        return {}

    def build_openai_thinking_kwargs(self, ai, *, thinking: str | None = None) -> dict:
        """返回 OpenAI SDK 调用所需的思考参数。"""
        params = self.build_thinking_params(ai, thinking=thinking)
        return {"extra_body": params} if params else {}

    def build_openai_cache_kwargs(self, ai) -> dict:
        """构造 OpenAI 兼容接口的本地 prompt cache 参数。"""
        return {}

    def build_anthropic_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        """返回 Anthropic SDK 调用所需的思考参数。"""
        return self.build_thinking_params(ai, thinking=thinking)

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        """返回结构化输出参数；默认不改变调用方行为。"""
        return {}

    def build_tool_params(self, ai, tools: list[dict]) -> dict:
        """返回工具调用参数；默认使用现有 OpenAI 兼容参数。"""
        return {"tools": tools, "tool_choice": "auto"} if tools else {}


@dataclass(frozen=True)
class MediaLimits:
    max_duration_s: int = 120
    max_size_bytes: int = 90 * 1024 * 1024
    compress_max_dim: int = 1920
    compress_bitrate: str = "5M"
    compress_trigger_bitrate: int = 16 * 1024 * 1024
    base64_max: int = 45 * 1024 * 1024
