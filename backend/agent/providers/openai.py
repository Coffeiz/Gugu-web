from urllib.parse import urlparse

from .base import (
    ApiFormat, ProviderAdapter, ProviderCapabilities, ReasoningCapabilities,
    ResponsesInputCapabilities, configured_responses_input_capabilities,
)


class OpenAIAdapter(ProviderAdapter):
    """OpenAI-compatible 默认适配。

    大多数中转站会忽略未知的 ``cache_control`` 字段，因此默认发送稳定的
    历史缓存锚点；真正支持自动缓存的服务仍通过 usage 返回命中统计。
    """

    name = "unknown"
    api_format = "anthropic"
    cache_mode = "active"

    def default_base_url_for(self, ai) -> str:
        if (getattr(ai, "provider", "") or "").lower() == "openai":
            return "https://api.openai.com/v1"
        return super().default_base_url_for(ai)

    def supports_explicit_cache(self, model: str = "") -> bool:
        return True

    def supports_responses_prompt_cache_key(self, ai) -> bool:
        # 该适配器也承接未知的 OpenAI-compatible provider；只有明确指向
        # 官方 OpenAI 端点时才发送 Responses 专属字段，避免重新制造兼容回归。
        if (getattr(ai, "provider", "") or "").lower() != "openai":
            return False
        base_url = (getattr(ai, "base_url", "") or "https://api.openai.com/v1").strip()
        return urlparse(base_url).hostname == "api.openai.com"

    def responses_store_value(self, ai) -> bool | None:
        if self.supports_responses_prompt_cache_key(ai):
            return False
        return None

    def build_responses_reasoning_replay_params(self, ai) -> dict:
        # encrypted_content 是 OpenAI 官方 Responses 的显式 include 项；不要把
        # OpenAI-compatible 服务假定为支持这个扩展字段。
        if self.supports_responses_prompt_cache_key(ai):
            return {"include": ["reasoning.encrypted_content"]}
        return {}

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="active", tools=True)

    def responses_input_capabilities(self, ai) -> ResponsesInputCapabilities:
        # 兼容端点仅在显式配置音频能力时发送官方格式；视频不作为通用协议能力推断。
        return configured_responses_input_capabilities(ai, audio_formats=frozenset({"mp3", "wav"}))

    def supported_api_formats(self, ai) -> tuple[ApiFormat, ...]:
        if (getattr(ai, "provider", "") or "").lower() == "openai":
            # API 协议由 OpenAI Provider 提供；具体模型能力在请求/能力层单独处理。
            return ("openai", "responses")
        return super().supported_api_formats(ai)

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        if (getattr(ai, "provider", "") or "").lower() != "openai":
            return ReasoningCapabilities()
        base_url = (getattr(ai, "base_url", "") or self.default_base_url_for(ai)).strip()
        if urlparse(base_url).hostname != "api.openai.com":
            return ReasoningCapabilities()
        if api_format not in self.supported_api_formats(ai):
            return ReasoningCapabilities()

        model = (getattr(ai, "model", "") or "").strip().lower()
        if model.startswith("gpt-5-pro"):
            efforts = ("high",)
        elif model.startswith("gpt-5.6"):
            efforts = ("none", "low", "medium", "high", "xhigh", "max")
        elif model.startswith("gpt-6-astra"):
            efforts = ("low", "medium", "high", "xhigh", "max")
        elif model.startswith(("gpt-6-sol", "gpt-6-luna")):
            efforts = ("none", "low", "medium", "high", "xhigh", "max")
        elif model.startswith("gpt-5.5"):
            efforts = ("low", "medium", "high", "xhigh")
        elif model in {"gpt-5", "gpt-5-mini", "gpt-5-nano"}:
            efforts = ("minimal", "low", "medium", "high")
        else:
            return ReasoningCapabilities()
        return ReasoningCapabilities(efforts=efforts)
