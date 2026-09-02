from .base import MediaLimits, ProviderAdapter, ProviderCapabilities


class MiniMaxAdapter(ProviderAdapter):
    name = "minimax"
    api_format = "anthropic"
    cache_mode = "active"
    transient_exceptions = (IndexError, KeyError, AttributeError)
    _MARKERS = ("]<]minimax", "[e~[")

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        model_l = (model or "").lower()
        cache = model_l.startswith(("minimax-m2", "minimax-m3"))
        return ProviderCapabilities(api_format="anthropic", cache_mode="active" if cache else "none",
                                    tools=True, video=model_l.startswith("minimax-m3"))

    def supports_active_cache(self, model: str = "") -> bool:
        return self.capabilities(model).cache_mode == "active"

    def supports_video(self, model: str = "") -> bool:
        # 兼容当前配置中 MiniMax M3 的多种模型 ID（如 abab-m3）。
        return "m3" in (model or "").lower()

    def stream_sanitize_markers(self) -> tuple[str, ...]:
        return self._MARKERS

    def build_anthropic_generation_params(self, ai) -> dict:
        # 新版 Anthropic SDK 的 stream() 不再接受顶层 temperature；MiniMax
        # 仍支持该请求体字段，因此通过 extra_body 传给兼容端点。
        return {"extra_body": {"temperature": ai.temperature}}

    def video_limits(self) -> MediaLimits:
        return MediaLimits()
