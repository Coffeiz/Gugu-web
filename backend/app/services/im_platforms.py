"""全局 IM 平台可用性策略。"""

from app.core.config import get_settings

IM_PLATFORMS = ("feishu", "qq", "wechat", "telegram")


def enabled_im_platforms() -> tuple[str, ...]:
    settings = get_settings().im
    return tuple(platform for platform in IM_PLATFORMS if getattr(settings, platform, True))


def is_im_platform_enabled(platform: str) -> bool:
    return platform in enabled_im_platforms()


def require_im_platform_enabled(platform: str) -> None:
    """平台全局关闭时拒绝新接入/配置操作，保留已有用户数据。"""
    from fastapi import HTTPException

    if not is_im_platform_enabled(platform):
        raise HTTPException(status_code=503, detail="该即时通讯平台暂未开放")


def im_platform_dependency(platform: str):
    def ensure_enabled() -> None:
        require_im_platform_enabled(platform)

    return ensure_enabled
