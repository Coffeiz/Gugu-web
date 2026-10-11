from .base import (
    ProviderAdapter, ProviderCapabilities, ReasoningCapabilities,
    ResponsesInputCapabilities, configured_responses_input_capabilities,
)


class MimoAdapter(ProviderAdapter):
    name = "mimo"
    api_format = "openai"
    cache_mode = "none"
    supports_thinking_toggle = True
    default_base_url = "https://api.xiaomimimo.com/v1"
    _AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg"})

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="none", thinking=True,
                                    structured_json=True, tools=True, audio=True, video=True)

    def supported_api_formats(self, ai):
        # MiMo 官方同时提供 Chat Completions、Responses 和 Anthropic Messages。
        return ("openai", "responses", "anthropic")

    def responses_input_capabilities(self, ai) -> ResponsesInputCapabilities:
        return configured_responses_input_capabilities(
            ai, audio_formats=self._AUDIO_EXTS, supports_video=True,
        )

    def default_base_url_for(self, ai) -> str:
        if self.protocol_format(ai) == "anthropic":
            return "https://api.xiaomimimo.com/anthropic"
        return self.default_base_url

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        if api_format in self.supported_api_formats(ai):
            return ReasoningCapabilities(modes=("disabled", "adaptive"))
        return ReasoningCapabilities()

    def auth_headers(self, ai) -> dict[str, str]:
        return {"api-key": getattr(ai, "api_key", "") or ""}

    def audio_native_exts(self) -> frozenset[str]:
        return self._AUDIO_EXTS

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        api_format = self.protocol_format(ai)
        if api_format not in {"openai", "anthropic"} or value not in self.reasoning_capabilities(ai, api_format).modes:
            return {}
        return {"thinking": {"type": "enabled" if value == "adaptive" else "disabled"}}

    def build_responses_reasoning_params(self, ai) -> dict:
        if self.protocol_format(ai) != "responses":
            return {}
        value = getattr(ai, "thinking", "disabled")
        if value == "disabled":
            return {"reasoning": {"effort": "none"}}
        # MiMo 暂不区分非 none 的思考档位；medium 用作开启思考的兼容值。
        return {"reasoning": {"effort": "medium"}}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}
