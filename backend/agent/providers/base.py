"""供应商适配器基类与共享能力模型。

这里仅描述「如何调用模型」的差异，不承载选模、工具循环或业务流程。
旧版 ProviderAdapter 的公开属性和方法保留，便于目录化迁移期间零行为变化。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse


ApiFormat = Literal["anthropic", "openai", "responses"]


def generic_thinking_toggle_supported(ai, api_format: str) -> bool:
    """判断配置是否处于通用兼容模式，且当前公共协议有通用思考开关映射。"""
    if api_format not in {"openai", "responses", "anthropic"}:
        return False
    provider = (getattr(ai, "provider", "") or "").strip().lower()
    base_url = (getattr(ai, "base_url", "") or "").strip()
    if provider == "local":
        return True
    if provider == "ollama":
        return getattr(ai, "ollama_api_mode", "native") != "native"

    if not base_url and provider == "openai":
        base_url = "https://api.openai.com/v1"
    elif not base_url and provider == "anthropic":
        base_url = "https://api.anthropic.com/v1"
    hostname = (urlparse(base_url).hostname or "").lower()
    if provider == "openai":
        return hostname != "api.openai.com" and api_format in {"openai", "responses"}
    if provider == "anthropic":
        return hostname != "api.anthropic.com" and api_format == "anthropic"

    # 已有专用适配器的 Provider 仍按其模型能力声明处理；未识别的 Provider
    # 以及未选择专用 Provider 的自定义端点属于通用兼容模式。
    specific_providers = {
        "qwen", "glm", "glm-coding", "deepseek", "minimax", "mimo",
    }
    return provider not in specific_providers and api_format == "openai"


def generic_thinking_params(ai, api_format: str) -> dict:
    """按公共协议映射通用兼容端点的显式思考开关。默认状态完全省略字段。"""
    if not generic_thinking_toggle_supported(ai, api_format):
        return {}
    thinking = getattr(ai, "thinking", None)
    if thinking not in {"disabled", "adaptive"}:
        return {}
    enabled = thinking == "adaptive"
    if api_format == "openai":
        return {"reasoning_effort": "high" if enabled else "none"}
    if api_format == "responses":
        return {"reasoning": {"effort": "medium" if enabled else "none"}}
    return {"thinking": {"type": "adaptive" if enabled else "disabled"}}


@dataclass(frozen=True)
class ReasoningCapabilities:
    """单个模型在单个 API 格式下支持的思考配置。"""

    modes: tuple[str, ...] = ()
    efforts: tuple[str, ...] = ()
    effort_map: tuple[tuple[str, str], ...] = ()
    # mode="adaptive" 在部分适配器中只是“启用思考”的内部兼容值；只有
    # Provider 明确承诺模型自行决定是否/何时思考时，才将此项设为 True。
    supports_adaptive_thinking: bool = False

    def provider_effort(self, value: str) -> str | None:
        if value not in self.efforts:
            return None
        return dict(self.effort_map).get(value, value)


@dataclass(frozen=True)
class ProviderCapabilities:
    """按模型声明的能力矩阵。

    供应商适配器可以按 model 覆盖，避免把同一供应商的所有模型误认为能力相同。
    """

    api_format: ApiFormat
    cache_mode: str = "none"
    thinking: bool = False
    structured_json: bool = False
    structured_schema: bool = False
    tools: bool = True
    parallel_tools: bool = False
    image: bool = False
    audio: bool = False
    video: bool = False


@dataclass(frozen=True)
class ResponsesInputCapabilities:
    """特定 Responses Provider/模型端点已验证的多模态输入格式。"""

    image: bool = False
    audio_formats: frozenset[str] = frozenset()
    video: bool = False


def configured_responses_input_capabilities(
    ai, *, audio_formats: frozenset[str] = frozenset(), supports_video: bool = False,
) -> ResponsesInputCapabilities:
    """将显式模型开关限制在当前 Provider 声明支持的输入格式内。"""
    overrides = getattr(ai, "capability_overrides", None) or {}
    image = overrides.get("image", getattr(ai, "image", False)) is True
    audio = overrides.get("audio", getattr(ai, "audio", False)) is True
    video = supports_video and overrides.get("video", getattr(ai, "video", False)) is True
    return ResponsesInputCapabilities(
        image=image,
        audio_formats=audio_formats if audio else frozenset(),
        video=video,
    )


class ProviderAdapter:
    """单个供应商/模型族的调用差异。

    兼容旧 API：调用方仍可读取 ``api_format``、``supports_thinking_toggle``、
    ``cache_mode``，并调用 ``supports_active_cache(model)`` 与 ``auth_headers(ai)``。
    """

    name = "unknown"
    api_format: Literal["anthropic", "openai", "responses"] = "anthropic"
    default_base_url = ""
    cache_mode = "active"
    supports_thinking_toggle = False
    transient_exceptions: tuple[type[BaseException], ...] = ()

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format=self.api_format, cache_mode=self.cache_mode,
                                    thinking=self.supports_thinking_toggle)

    def responses_input_capabilities(self, ai) -> ResponsesInputCapabilities:
        """声明 Responses 输入格式能力；未知 Provider 默认仅支持文本。"""
        return configured_responses_input_capabilities(ai)

    def supports_active_cache(self, model: str = "") -> bool:
        return self.capabilities(model).cache_mode == "active"

    def supports_responses_prompt_cache_key(self, ai) -> bool:
        """是否确认支持 Responses 的 ``prompt_cache_key`` 请求字段。"""
        return False

    def responses_store_value(self, ai) -> bool | None:
        """返回 Responses 的服务端存储参数；None 表示省略未确认的兼容字段。"""
        return None

    def supported_api_formats(self, ai) -> tuple[ApiFormat, ...]:
        """返回该 Provider 已声明的公共协议；默认只开放当前默认协议。"""
        model = getattr(ai, "model", "") or ""
        return (self.capabilities(model).api_format,)

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        """返回模型/协议组合支持的推理档位；未知组合默认不发送档位参数。"""
        return ReasoningCapabilities()

    def _reasoning_effort(self, ai, api_format: str) -> str | None:
        capabilities = self.reasoning_capabilities(ai, api_format)
        if getattr(ai, "thinking", None) == "disabled":
            return "none" if "none" in capabilities.efforts else None
        value = (getattr(ai, "reasoning_effort", "") or "").lower()
        if not value:
            return None
        return capabilities.provider_effort(value)

    def build_responses_reasoning_params(self, ai) -> dict:
        """构造 Responses API 推理档位；不支持或默认配置时省略字段。"""
        effort = self._reasoning_effort(ai, "responses")
        return {"reasoning": {"effort": effort}} if effort else {}

    def build_responses_reasoning_replay_params(self, ai) -> dict:
        """构造取回可恢复推理项所需的 Responses 参数。"""
        return {}

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
        """把不可变 Area snapshot 转换为本 provider 的请求前历史。"""
        from agent.context.assembly.area import MessageArea
        if isinstance(messages, MessageArea):
            from agent.context.history import render_canonical_area_snapshot
            options = dict(messages.render_options or {})
            options.setdefault("api_format", self.api_format)
            return render_canonical_area_snapshot(
                messages.snapshot(), source=messages, options=options,
            )
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

    def default_base_url_for(self, ai) -> str:
        return self.default_base_url

    def resolve_base_url(self, ai) -> str:
        """返回本次请求地址；允许本地服务使用默认地址而不保存伪造配置。"""
        return (getattr(ai, "base_url", "") or self.default_base_url_for(ai)).rstrip("/")

    def diagnostic_request(self, ai) -> dict:
        """构造后台连通性测试请求，不执行请求也不返回密钥。"""
        protocol = self.protocol_format(ai)
        from app.core.credentials import normalize_ascii_api_key
        api_key = normalize_ascii_api_key(
            getattr(ai, "api_key", "") or ("ollama" if self.name == "ollama" else ""),
            label="模型 API Key",
        )
        if protocol == "anthropic":
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01",
                       "content-type": "application/json"}
            # Anthropic SDK 的 base_url 可带 /v1；MiniMax 兼容端点通常只到
            # /anthropic，需要把版本路径补上，否则诊断请求会落到 404。
            base_url = (getattr(ai, "base_url", "") or "").rstrip("/")
            path = "/messages" if not base_url or base_url.endswith("/v1") else "/v1/messages"
            payload = {"model": getattr(ai, "model", ""), "max_tokens": 1,
                       "messages": [{"role": "user", "content": "hi"}]}
        elif protocol == "responses":
            headers = {"content-type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            path = "/responses"
            payload = {
                "model": getattr(ai, "model", ""), "max_output_tokens": 1,
                "input": [{"role": "user", "content": "hi"}],
            }
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
        path = "/models" if protocol in {"openai", "responses"} or base_url.endswith("/v1") else "/v1/models"
        headers = {"Accept": "application/json"}
        from app.core.credentials import normalize_ascii_api_key
        api_key = normalize_ascii_api_key(
            getattr(ai, "api_key", "") or ("ollama" if self.name == "ollama" else ""),
            label="模型 API Key",
        )
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

    def protocol_format(self, ai) -> Literal["anthropic", "openai", "responses"]:
        """解析本次请求使用的协议格式，集中处理显式配置和地址兼容规则。"""
        configured = (getattr(ai, "api_format", "") or "").lower()
        if configured in ("anthropic", "openai", "responses", "openai_responses"):
            return "responses" if configured == "openai_responses" else configured
        if self.name in ("anthropic", "minimax"):
            return "anthropic"
        # 已知 OpenAI-compatible Provider 的空配置代表其固定默认协议。
        # 不能再从自定义 URL 中猜测协议，否则 Qwen 等 Provider 配置了包含
        # ``anthropic`` 字样的地址时会被错误切到 Anthropic 请求体。
        known_openai_providers = {"openai", "qwen", "glm", "glm-coding", "deepseek", "mimo", "ollama", "local"}
        if self.name in known_openai_providers or \
                (getattr(ai, "provider", "") or "").lower() in known_openai_providers:
            return "openai"
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
        kwargs = {"extra_body": params} if params else {}
        effort = self._reasoning_effort(ai, "openai")
        if effort and "reasoning_effort" not in params:
            kwargs["reasoning_effort"] = effort
        return kwargs

    def build_openai_cache_kwargs(self, ai) -> dict:
        """构造 OpenAI 兼容接口的本地 prompt cache 参数。"""
        return {}

    def build_anthropic_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        """返回 Anthropic SDK 调用所需的思考参数。"""
        params = self.build_thinking_params(ai, thinking=thinking)
        effort = self._reasoning_effort(ai, "anthropic")
        if effort:
            params["output_config"] = {"effort": effort}
        return params

    def build_anthropic_generation_params(self, ai) -> dict:
        """返回 Anthropic 兼容端点的额外生成参数。"""
        return {}

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
