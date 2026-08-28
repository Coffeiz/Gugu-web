"""BYOK 总开关与部署模式策略。"""
from app.core.config import get_settings


def byok_enabled() -> bool:
    settings = get_settings()
    return bool(settings.byok.enabled or settings.ai.deployment_mode == "local")


def require_byok_enabled() -> None:
    if not byok_enabled():
        raise PermissionError("用户 BYOK 未开放")
