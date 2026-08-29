"""智谱 GLM 的 OpenAI 兼容接口适配。"""
from .base import ProviderAdapter, ProviderCapabilities


class GlmAdapter(ProviderAdapter):
    """GLM 通用 API 适配器。

    智谱的通用 API 使用 OpenAI 兼容协议。缓存能力暂不主动声明，等真实
    预设和模型完成验证后再单独调整，避免误发供应商不支持的缓存参数。
    """

    name = "glm"
    api_format = "openai"
    cache_mode = "none"
    supports_thinking_toggle = True
    default_base_url = "https://open.bigmodel.cn/api/paas/v4"

    @staticmethod
    def _supports_thinking(model: str) -> bool:
        model_l = (model or "").strip().lower()
        return model_l.startswith(("glm-4.5", "glm-4.6", "glm-4.7", "glm-5"))

    @staticmethod
    def _supports_vision(model: str) -> bool:
        model_l = (model or "").strip().lower()
        return model_l.startswith(("glm-4v", "glm-4.1v", "glm-5v"))

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(
            api_format="openai",
            cache_mode="none",
            thinking=self._supports_thinking(model),
            structured_json=True,
            tools=True,
            vision=self._supports_vision(model),
        )

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        model = getattr(ai, "model", "") or ""
        if not self._supports_thinking(model):
            return {}
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        return {"thinking": {"type": "enabled" if value == "adaptive" else "disabled"}}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}


class GlmCodingAdapter(GlmAdapter):
    """GLM Coding Plan 专属 OpenAI 兼容端点。

    Coding Plan 的模型能力与通用 GLM API 共用适配规则，但端点和套餐
    鉴权边界不同，因此在 provider 层保留独立身份，便于 Admin 明确配置。
    """

    name = "glm-coding"
    default_base_url = "https://open.bigmodel.cn/api/coding/paas/v4"

    def _supports_vision(self, model: str) -> bool:
        # 官方 Coding Plan 接入示例要求关闭图片能力，保持保守声明。
        return False
