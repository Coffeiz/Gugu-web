from .base import ProviderAdapter, ProviderCapabilities


class DeepSeekAdapter(ProviderAdapter):
    name = "deepseek"
    api_format = "openai"
    cache_mode = "active"
    supports_thinking_toggle = True

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="active", thinking=True,
                                    structured_json=True, tools=True)

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        if value == "adaptive":
            params = {}
            effort = getattr(ai, "reasoning_effort", "")
            if effort:
                params["reasoning_effort"] = effort
            return params
        return {"thinking": {"type": "disabled"}}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}
