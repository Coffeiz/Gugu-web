from urllib.parse import urlparse

from .base import ProviderAdapter, ProviderCapabilities


class OpenAIAdapter(ProviderAdapter):
    """OpenAI-compatible 默认适配。

    大多数中转站会忽略未知的 ``cache_control`` 字段，因此默认发送稳定的
    历史缓存锚点；真正支持自动缓存的服务仍通过 usage 返回命中统计。
    """

    name = "unknown"
    api_format = "anthropic"
    cache_mode = "active"

    def supports_explicit_cache(self, model: str = "") -> bool:
        return True

    def supports_responses_prompt_cache_key(self, ai) -> bool:
        # 该适配器也承接未知的 OpenAI-compatible provider；只有明确指向
        # 官方 OpenAI 端点时才发送 Responses 专属字段，避免重新制造兼容回归。
        if (getattr(ai, "provider", "") or "").lower() != "openai":
            return False
        base_url = (getattr(ai, "base_url", "") or "https://api.openai.com/v1").strip()
        return urlparse(base_url).hostname == "api.openai.com"

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="active", tools=True)
