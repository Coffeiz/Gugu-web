from .base import ProviderAdapter, ProviderCapabilities


class QwenAdapter(ProviderAdapter):
    name = "qwen"
    api_format = "openai"
    cache_mode = "active"
    supports_thinking_toggle = True

    def supports_explicit_cache(self, model: str = "") -> bool:
        return self.supports_active_cache(model)

    def uses_single_history_cache_anchor(self, model: str = "") -> bool:
        # Token Plan 的 OpenAI 兼容端点对多个历史 cache_control 锚点命中不稳定；
        # 保留系统前缀锚点，只发送最新稳定历史尾锚点。
        return self.supports_explicit_cache(model)

    @staticmethod
    def _qwen3_model(model: str) -> bool:
        return (model or "").strip().lower().startswith("qwen3")

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        # 百炼能力按模型族收窄：老的 qwen-max 不能因为 provider 名称相同就
        # 被误发 Qwen3 专属参数；当前 devserver 的 qwen3.8-max 属于支持族。
        qwen3 = self._qwen3_model(model)
        return ProviderCapabilities(
            api_format="openai", cache_mode="active", thinking=qwen3,
            structured_json=qwen3, structured_schema=qwen3, tools=True,
            parallel_tools=False,
        )

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        """构造百炼 OpenAI 兼容接口的 Qwen3 思考参数。

        OpenAI SDK 调用方会把返回值放进 ``extra_body``；原始 HTTP 探测会由
        ProviderAdapter 展开到 payload 顶层。adaptive 按百炼默认行为不显式改写。
        """
        model = getattr(ai, "model", "") or ""
        if not self._qwen3_model(model):
            return {}
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        if value == "disabled":
            return {"enable_thinking": False}
        # qwen3.8-max 等模型默认开启思考；不发送 enable_thinking 以保持服务端默认。
        # 只要本轮可能返回 reasoning_content，就要求百炼按原字段接收后续历史，
        # 不能把思考块折叠进 content。
        return {"preserve_thinking": True}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        """百炼 Qwen3 的 JSON mode；思考参数由调用方同时关闭。"""
        if not self.capabilities(getattr(ai, "model", "")).structured_json:
            return {}
        if schema:
            # 调用方可以传完整的 json_schema 定义，也可以只传 JSON Schema
            # 本体；两种形式统一成百炼要求的包装结构。
            definition = schema
            if "name" not in schema or "schema" not in schema:
                definition = {"name": "gugu_output", "schema": schema}
            return {"response_format": {
                "type": "json_schema",
                "json_schema": definition,
            }}
        return {"response_format": {"type": "json_object"}}
