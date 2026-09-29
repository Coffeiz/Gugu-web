"""智谱 GLM 的 OpenAI 兼容接口适配。"""
from .base import ProviderAdapter, ProviderCapabilities, ReasoningCapabilities


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
    def _glm53(model: str) -> bool:
        return (model or "").strip().lower().startswith(("glm-5.3", "glm-5.3-flash"))

    def supported_api_formats(self, ai):
        # GLM-5.3 的模型文档列出 Chat、Responses 和 Anthropic 兼容端点；
        # 其它型号目前只开放通用 Chat 协议，避免按供应商整体推断兼容性。
        if self._glm53(getattr(ai, "model", "") or ""):
            return ("openai", "responses", "anthropic")
        return ("openai",)

    def default_base_url_for(self, ai) -> str:
        if self._glm53(getattr(ai, "model", "") or ""):
            protocol = self.protocol_format(ai)
            if protocol == "responses":
                return "https://open.bigmodel.cn/api/v1"
            if protocol == "anthropic":
                return "https://open.bigmodel.cn/api/anthropic"
        return self.default_base_url

    @staticmethod
    def _supports_thinking(model: str) -> bool:
        model_l = (model or "").strip().lower()
        return model_l.startswith(("glm-4.5", "glm-4.6", "glm-4.7", "glm-5"))

    @staticmethod
    def _supports_image(model: str) -> bool:
        model_l = (model or "").strip().lower()
        return model_l.startswith(("glm-4v", "glm-4.1v", "glm-5v"))

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        return ProviderCapabilities(
            api_format="openai",
            cache_mode="none",
            thinking=self._supports_thinking(model),
            structured_json=True,
            tools=True,
            image=self._supports_image(model),
        )

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        model = getattr(ai, "model", "") or ""
        if self._glm53(model):
            if api_format == "openai":
                return ReasoningCapabilities(modes=("adaptive",), efforts=("low", "high", "max"))
            # 模型文档列出了这两个协议的端点，但没有明确思考参数的协议映射。
            return ReasoningCapabilities()
        if api_format == "openai" and self._supports_thinking(model):
            return ReasoningCapabilities(modes=("disabled", "adaptive"))
        return ReasoningCapabilities()

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        model = getattr(ai, "model", "") or ""
        if self._glm53(model):
            # GLM-5.3 固定启用思考，不向服务端发送关闭开关。
            return {}
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

    def supported_api_formats(self, ai):
        # Coding Plan 目前仅允许 Chat Completion 协议。
        return ("openai",)

    def default_base_url_for(self, ai) -> str:
        return self.default_base_url

    def _supports_image(self, model: str) -> bool:
        # 官方 Coding Plan 接入示例要求关闭图片能力，保持保守声明。
        return False
