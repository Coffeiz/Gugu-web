from .base import ProviderAdapter, ProviderCapabilities


class AnthropicAdapter(ProviderAdapter):
    name = "anthropic"
    api_format = "anthropic"
    cache_mode = "active"

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="anthropic", cache_mode="active", tools=True)

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        return {"thinking": {"type": value}} if value == "adaptive" else {}
