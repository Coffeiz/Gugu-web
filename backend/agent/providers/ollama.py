from .base import ProviderAdapter, ProviderCapabilities


class OllamaAdapter(ProviderAdapter):
    """Ollama 本地与 Cloud 的协议配置；原生请求由 OllamaDriver 执行。"""

    name = "ollama"
    api_format = "openai"
    cache_mode = "none"
    default_base_url = "http://127.0.0.1:11434/v1"
    cloud_base_url = "https://ollama.com/v1"
    native_default_base_url = "http://127.0.0.1:11434/api"
    native_cloud_base_url = "https://ollama.com/api"

    def resolve_base_url(self, ai) -> str:
        if getattr(ai, "ollama_api_mode", "native") == "native":
            return self.resolve_native_base_url(ai)
        configured = (getattr(ai, "base_url", "") or "").strip()
        if configured:
            return configured.rstrip("/")
        if getattr(ai, "ollama_mode", "local") == "cloud":
            return self.cloud_base_url
        return self.default_base_url

    def resolve_native_base_url(self, ai) -> str:
        configured = (getattr(ai, "base_url", "") or "").strip().rstrip("/")
        if configured:
            if configured.endswith("/v1"):
                configured = configured[:-3]
            return configured if configured.endswith("/api") else configured + "/api"
        if getattr(ai, "ollama_mode", "local") == "cloud":
            return self.native_cloud_base_url
        return self.native_default_base_url

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        # 这些是 Ollama OpenAI-compatible chat completions 的协议能力；具体模型是否
        # 支持视觉/思考仍由模型本身决定，视觉能力不在这里全局打开。
        return ProviderCapabilities(api_format="openai", cache_mode="none", thinking=True,
                                    structured_json=True, tools=True)

    def diagnostic_request(self, ai) -> dict:
        if getattr(ai, "ollama_api_mode", "native") != "native":
            return super().diagnostic_request(ai)
        api_key = getattr(ai, "api_key", "") or "ollama"
        return {
            "path": "/chat",
            "headers": {"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
            "payload": {"model": getattr(ai, "model", ""), "stream": False,
                        "think": False, "messages": [{"role": "user", "content": "hi"}]},
        }

    def models_request(self, ai) -> dict:
        if getattr(ai, "ollama_api_mode", "native") != "native":
            return super().models_request(ai)
        return {"path": "/tags", "headers": {"Accept": "application/json"}}

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        """使用 Ollama OpenAI 兼容接口声明的 reasoning_effort 字段。"""
        value = thinking if thinking is not None else getattr(ai, "thinking", "disabled")
        if value != "adaptive":
            return {"reasoning_effort": "none"}
        effort = getattr(ai, "reasoning_effort", "") or "medium"
        if effort not in {"low", "medium", "high", "max"}:
            effort = "medium"
        return {"reasoning_effort": effort}

    def build_structured_output(self, ai, schema: dict | None = None) -> dict:
        # Ollama /v1/chat/completions 支持 response_format 的 JSON mode。
        return {"response_format": {"type": "json_object"}}
