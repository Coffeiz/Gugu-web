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

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="active", tools=True)
