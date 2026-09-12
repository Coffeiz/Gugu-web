from .base import ProviderAdapter, ProviderCapabilities


class DeepSeekAdapter(ProviderAdapter):
    name = "deepseek"
    api_format = "openai"
    cache_mode = "active"
    supports_thinking_toggle = True

    def supports_explicit_cache(self, model: str = "") -> bool:
        """DeepSeek 使用服务端自动前缀缓存，不接受显式 cache_control 锚点。"""
        return False

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        # 当前 deepseek-flash 支持图片输入；旧 Vision Exp 名称仍由服务端兼容承接。
        # 普通文本模型仍保持 vision=False，避免把图片误发给不支持多模态的模型。
        vision = model.strip().lower() in {
            "deepseek-flash",
            "deepseek-v4-flash-vision-exp",
        }
        return ProviderCapabilities(api_format="openai", cache_mode="active", thinking=True,
                                    structured_json=True, tools=True, vision=vision)

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        return {"thinking": {"type": "enabled" if value == "adaptive" else "disabled"}}

    @staticmethod
    def _reasoning_effort(ai) -> str | None:
        effort = (getattr(ai, "reasoning_effort", "") or "").lower()
        if effort == "medium":
            return "low"
        if effort == "xhigh":
            return "max"
        return effort if effort in {"low", "high", "max"} else None

    def build_openai_thinking_kwargs(self, ai, *, thinking: str | None = None) -> dict:
        kwargs = {"extra_body": self.build_thinking_params(ai, thinking=thinking)}
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        effort = self._reasoning_effort(ai) if value == "adaptive" else None
        if effort:
            kwargs["reasoning_effort"] = effort
        return kwargs

    def build_anthropic_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        params = self.build_thinking_params(ai, thinking=thinking)
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        effort = self._reasoning_effort(ai) if value == "adaptive" else None
        if effort:
            params["output_config"] = {"effort": effort}
        return params

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}
