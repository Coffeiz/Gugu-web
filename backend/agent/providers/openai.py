from .base import ProviderAdapter, ProviderCapabilities


class OpenAIAdapter(ProviderAdapter):
    """其它 OpenAI 兼容供应商的保守默认适配。"""

    name = "unknown"
    api_format = "anthropic"
    cache_mode = "none"

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="none", tools=True)
