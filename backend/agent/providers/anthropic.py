from .base import ProviderAdapter, ProviderCapabilities, ReasoningCapabilities
from urllib.parse import urlparse


class AnthropicAdapter(ProviderAdapter):
    name = "anthropic"
    api_format = "anthropic"
    cache_mode = "active"
    default_base_url = "https://api.anthropic.com/v1"

    @staticmethod
    def _supports_adaptive_thinking(model: str) -> bool:
        model_l = (model or "").strip().lower()
        return model_l.startswith((
            "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
            "claude-sonnet-4-6", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5",
        ))

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="anthropic", cache_mode="active", tools=True,
                                    thinking=self._supports_adaptive_thinking(model))

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        if api_format != "anthropic":
            return ReasoningCapabilities()
        base_url = (getattr(ai, "base_url", "") or self.default_base_url_for(ai)).strip()
        if urlparse(base_url).hostname != "api.anthropic.com":
            return ReasoningCapabilities()
        model = (getattr(ai, "model", "") or "").strip().lower()
        if model.startswith(("claude-opus-4-6", "claude-opus-4-7")):
            efforts = ("low", "medium", "high")
        elif model.startswith("claude-opus-4-8"):
            efforts = ("low", "medium", "high", "xhigh")
        elif model.startswith("claude-opus-5"):
            efforts = ("low", "medium", "high", "xhigh", "max")
        elif model.startswith(("claude-sonnet-4-6", "claude-sonnet-5")):
            efforts = ("low", "medium", "high")
        elif model.startswith(("claude-fable-5", "claude-mythos-5")):
            return ReasoningCapabilities(modes=("adaptive",))
        else:
            return ReasoningCapabilities()
        return ReasoningCapabilities(modes=("adaptive",), efforts=efforts)

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        capabilities = self.reasoning_capabilities(ai, "anthropic")
        return {"thinking": {"type": value}} if value in capabilities.modes else {}
