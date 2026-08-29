from .base import ProviderAdapter, ProviderCapabilities


class MimoAdapter(ProviderAdapter):
    name = "mimo"
    api_format = "openai"
    cache_mode = "none"
    supports_thinking_toggle = True
    _AUDIO_EXTS = frozenset({"mp3", "wav", "flac", "m4a", "ogg"})

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(api_format="openai", cache_mode="none", thinking=True,
                                    structured_json=True, tools=True, audio=True, video=True)

    def auth_headers(self, ai) -> dict[str, str]:
        return {"api-key": getattr(ai, "api_key", "") or ""}

    def audio_native_exts(self) -> frozenset[str]:
        return self._AUDIO_EXTS

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        return {} if value == "adaptive" else {"thinking": {"type": "disabled"}}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}
