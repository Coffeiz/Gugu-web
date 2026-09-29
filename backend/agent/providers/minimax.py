from .base import MediaLimits, ProviderAdapter, ProviderCapabilities, ReasoningCapabilities


class MiniMaxAdapter(ProviderAdapter):
    name = "minimax"
    api_format = "anthropic"
    cache_mode = "active"
    default_base_url = "https://api.minimaxi.com/anthropic"
    transient_exceptions = (IndexError, KeyError, AttributeError)
    _MARKERS = ("]<]minimax", "[e~[")

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        model_l = (model or "").lower()
        cache = model_l.startswith(("minimax-m2", "minimax-m3"))
        thinking = model_l.startswith(("minimax-m2", "minimax-m3"))
        return ProviderCapabilities(api_format="anthropic", cache_mode="active" if cache else "none",
                                    thinking=thinking, tools=True,
                                    image=model_l.startswith("minimax-m3"),
                                    video=model_l.startswith("minimax-m3"))

    def supported_api_formats(self, ai):
        # 官方同时提供 Anthropic 兼容与 OpenAI 兼容文本 API；Anthropic 为推荐且默认协议。
        return ("anthropic", "openai")

    def default_base_url_for(self, ai) -> str:
        if self.protocol_format(ai) == "openai":
            return "https://api.minimax.cn/v1"
        return self.default_base_url

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        if api_format not in self.supported_api_formats(ai):
            return ReasoningCapabilities()
        model = (getattr(ai, "model", "") or "").strip().lower()
        if model.startswith("minimax-m3.1-flash-preview"):
            return ReasoningCapabilities(
                modes=("adaptive",),
                efforts=("low", "medium", "high", "xhigh", "max"),
            )
        if model.startswith(("minimax-m3", "minimax-m2")):
            if api_format == "openai" and model.startswith("minimax-m3"):
                return ReasoningCapabilities(modes=("disabled", "adaptive"))
            return ReasoningCapabilities(modes=("adaptive",))
        return ReasoningCapabilities()

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        if self.protocol_format(ai) != "openai":
            return {}
        model = (getattr(ai, "model", "") or "").strip().lower()
        capabilities = self.reasoning_capabilities(ai, "openai")
        value = thinking if thinking is not None else getattr(ai, "thinking", None)
        if value not in capabilities.modes:
            return {}
        if value == "disabled" and model.startswith("minimax-m3"):
            return {"thinking": {"type": "disabled"}}
        if value == "adaptive":
            return {"thinking": {"type": "adaptive"}}
        return {}

    def build_openai_thinking_kwargs(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", None)
        params = self.build_thinking_params(ai, thinking=value)
        kwargs = {"extra_body": params} if params else {}
        if value == "adaptive":
            effort = self._reasoning_effort(ai, "openai")
            if effort:
                kwargs["reasoning_effort"] = effort
        return kwargs

    def supports_active_cache(self, model: str = "") -> bool:
        return self.capabilities(model).cache_mode == "active"

    def supports_video(self, model: str = "") -> bool:
        # 兼容当前配置中 MiniMax M3 的多种模型 ID（如 abab-m3）。
        return "m3" in (model or "").lower()

    def stream_sanitize_markers(self) -> tuple[str, ...]:
        return self._MARKERS

    def build_anthropic_generation_params(self, ai) -> dict:
        # temperature 已全局下线（anthropic SDK 1.x 的 stream()/create() 不再接受
        # 顶层 temperature，模型一律用 provider 默认采样）。
        return {}

    def video_limits(self) -> MediaLimits:
        return MediaLimits()
