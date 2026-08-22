from .base import ProviderAdapter, ProviderCapabilities
from urllib.parse import urlparse


def validate_local_base_url(url: str) -> str:
    """校验本地服务地址格式；本地部署允许 loopback/内网地址，但禁止凭据和非 HTTP 协议。"""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("本地模型 Base URL 只支持带主机名的 http/https 地址")
    if parsed.username or parsed.password:
        raise ValueError("本地模型 Base URL 不得嵌入用户名或密码")
    if parsed.fragment:
        raise ValueError("本地模型 Base URL 不得包含 URL fragment")
    return url.rstrip("/")


class LocalAdapter(ProviderAdapter):
    """llama.cpp、vLLM 及其它本地 OpenAI 兼容服务的统一适配器。"""

    name = "local"
    api_format = "openai"
    cache_mode = "none"

    DEFAULT_BASE_URLS = {
        "llama.cpp": "http://127.0.0.1:8080/v1",
        "vllm": "http://127.0.0.1:8000/v1",
        "other": "http://127.0.0.1:8000/v1",
    }

    def resolve_base_url(self, ai) -> str:
        configured = (getattr(ai, "base_url", "") or "").strip()
        if configured:
            return validate_local_base_url(configured)
        runtime = getattr(ai, "local_runtime", "other") or "other"
        return validate_local_base_url(self.DEFAULT_BASE_URLS.get(runtime, self.DEFAULT_BASE_URLS["other"]))

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        # 本地服务的高级能力必须经过探测或人工覆盖，不能按运行时名称误报。
        return ProviderCapabilities(api_format="openai", cache_mode="none", tools=False)
