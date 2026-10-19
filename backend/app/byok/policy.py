"""BYOK 总开关与部署模式策略。"""
from app.core.config import get_settings


def byok_enabled() -> bool:
    settings = get_settings()
    return bool(settings.byok.enabled or settings.ai.deployment_mode == "local")


def provider_web_search_supported(provider: str, api_format: str = "") -> bool:
    """判断配置协议是否提供了可调度的 Provider 原生联网搜索。"""
    normalized_provider = (provider or "").strip().lower()
    normalized_format = (api_format or "openai").strip().lower()
    if normalized_provider in {"minimax", "glm", "deepseek", "mimo", "ollama"}:
        return True
    return normalized_provider == "qwen" and normalized_format in {"openai", "responses"}


def require_byok_enabled() -> None:
    if not byok_enabled():
        raise PermissionError("用户 BYOK 未开放")
