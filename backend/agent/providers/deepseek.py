from .base import ProviderAdapter, ProviderCapabilities, ReasoningCapabilities


class DeepSeekAdapter(ProviderAdapter):
    name = "deepseek"
    api_format = "openai"
    cache_mode = "active"
    supports_thinking_toggle = True
    default_base_url = "https://api.deepseek.com"

    def supports_explicit_cache(self, model: str = "") -> bool:
        """DeepSeek 使用服务端自动前缀缓存，不接受显式 cache_control 锚点。"""
        return False

    def supported_api_formats(self, ai):
        # 当前 DeepSeek 文档支持 Chat、Responses 和 Anthropic 兼容协议；默认仍为 Chat。
        return ("openai", "responses", "anthropic")

    def default_base_url_for(self, ai) -> str:
        if self.protocol_format(ai) == "anthropic":
            return "https://api.deepseek.com/anthropic"
        return self.default_base_url

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        # 当前 deepseek-flash 支持图片输入；旧 Vision Exp 名称仍由服务端兼容承接。
        # 普通文本模型仍保持 image=False，避免把图片误发给不支持多模态的模型。
        image = model.strip().lower() in {
            "deepseek-flash",
            "deepseek-v4-flash-vision-exp",
        }
        return ProviderCapabilities(api_format="openai", cache_mode="active",
                                    thinking=self._supports_reasoning(model),
                                    structured_json=True, tools=True, image=image)

    @staticmethod
    def _supports_reasoning(model: str) -> bool:
        model = (model or "").strip().lower()
        return model.startswith(("deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"))

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        if api_format not in self.supported_api_formats(ai) or not self._supports_reasoning(
            getattr(ai, "model", "") or ""
        ):
            return ReasoningCapabilities()
        efforts = ("minimal", "low", "medium", "high", "xhigh", "max")
        effort_map = (
            ("minimal", "low"),
            ("medium", "high"),
            ("xhigh", "high"),
        )
        if api_format == "responses":
            return ReasoningCapabilities(
                modes=("disabled", "adaptive"),
                efforts=("none", *efforts),
                effort_map=effort_map,
            )
        return ReasoningCapabilities(
            modes=("disabled", "adaptive"),
            efforts=efforts,
            effort_map=effort_map,
        )

    def build_responses_reasoning_params(self, ai) -> dict:
        if not self._supports_reasoning(getattr(ai, "model", "") or ""):
            return {}
        if getattr(ai, "thinking", "disabled") == "disabled":
            return {"reasoning": {"effort": "none"}}
        return super().build_responses_reasoning_params(ai)

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        if not self._supports_reasoning(getattr(ai, "model", "") or ""):
            return {}
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        if value not in self.reasoning_capabilities(ai, "openai").modes:
            return {}
        return {"thinking": {"type": "enabled" if value == "adaptive" else "disabled"}}

    def build_openai_thinking_kwargs(self, ai, *, thinking: str | None = None) -> dict:
        params = self.build_thinking_params(ai, thinking=thinking)
        kwargs = {"extra_body": params} if params else {}
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        effort = self._reasoning_effort(ai, "openai") if value == "adaptive" else None
        if effort:
            kwargs["reasoning_effort"] = effort
        return kwargs

    def build_anthropic_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        if not self._supports_reasoning(getattr(ai, "model", "") or ""):
            return {}
        if value not in self.reasoning_capabilities(ai, "anthropic").modes:
            return {}
        if value == "disabled":
            # DeepSeek 的 Anthropic 兼容协议使用 reasoning.effort=none 关闭思考。
            return {"reasoning": {"effort": "none"}}
        params = {"thinking": {"type": "enabled"}}
        if value != "adaptive":
            return params
        effort = self._reasoning_effort(ai, "anthropic")
        if effort:
            params["output_config"] = {"effort": effort}
        return params

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}
