from .base import ProviderAdapter, ProviderCapabilities


class QwenAdapter(ProviderAdapter):
    name = "qwen"
    api_format = "openai"
    cache_mode = "active"

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        # Qwen 的具体 thinking/结构化输出能力在 PRD-LLM-6 验证后再打开。
        return ProviderCapabilities(api_format="openai", cache_mode="active", tools=True)
