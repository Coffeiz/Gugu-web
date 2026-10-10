"""智谱 GLM 的 OpenAI 兼容接口适配。"""
from .base import ProviderAdapter, ProviderCapabilities, ReasoningCapabilities


_GLM53_RESPONSES_REASONING = ReasoningCapabilities(
    modes=("disabled", "adaptive"),
    efforts=("none", "minimal", "low", "medium", "high", "xhigh", "max"),
    effort_map=(
        ("minimal", "none"),
        ("low", "high"),
        ("medium", "high"),
        ("xhigh", "max"),
    ),
)


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
        # 协议是 GLM 通用 API 的接入能力，不随当前选择的模型改变。
        return ("openai", "responses", "anthropic")

    def responses_store_value(self, ai) -> bool | None:
        return False if self.protocol_format(ai) == "responses" else None

    def default_base_url_for(self, ai) -> str:
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
            if api_format == "responses":
                return _GLM53_RESPONSES_REASONING
            # 未核实 Chat/Anthropic 思考映射，使用端点默认。
            return ReasoningCapabilities()
        if api_format == "openai" and self._supports_thinking(model):
            return ReasoningCapabilities(modes=("disabled", "adaptive"))
        return ReasoningCapabilities()

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        model = getattr(ai, "model", "") or ""
        if self._glm53(model):
            # GLM-5.3 的 Chat 思考开关尚无当前官方文档依据，不主动发送字段。
            return {}
        if not self._supports_thinking(model):
            return {}
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        return {"thinking": {"type": "enabled" if value == "adaptive" else "disabled"}}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        return {"response_format": {"type": "json_object"}}

class GlmCodingAdapter(GlmAdapter):
    """GLM Coding Plan 适配器。

    Coding Plan 的模型能力与通用 GLM API 共用规则，但套餐身份独立；
    不同 API 格式由对应的 GLM 端点承载。
    """

    name = "glm-coding"
    default_base_url = "https://open.bigmodel.cn/api/coding/paas/v4"

    def supported_api_formats(self, ai):
        # Coding Plan 也提供 Anthropic/Responses 接入；各协议使用各自套餐端点。
        return ("openai", "responses", "anthropic")

    def default_base_url_for(self, ai) -> str:
        if self.protocol_format(ai) == "openai":
            return self.default_base_url
        return super().default_base_url_for(ai)

    def _supports_image(self, model: str) -> bool:
        # 官方 Coding Plan 接入示例要求关闭图片能力，保持保守声明。
        return False
