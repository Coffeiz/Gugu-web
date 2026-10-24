"""交互展示偏好。

偏好只控制 IM 的可见呈现，不参与工具执行、权限判断或确认消费。
缺少设置或暂时无法读取时，默认展示工具调用和慢工具进度声明，并隐藏中间轮次回复。
"""
from __future__ import annotations


async def im_display_preferences(user_id) -> tuple[str, bool]:
    """一次读取 IM 展示偏好；缺失或读取失败时使用产品默认值。"""
    from sqlalchemy import select
    from app.db import session as db_session
    from app.models import UserPreferences
    from app.services.user_preferences import normalize_im_tool_display_mode

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return "all", False
        async with db_session._SessionLocal() as db:
            row = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
            data = (row.data or {}) if row else {}
            mode = normalize_im_tool_display_mode(data.get("im_tool_display_mode"))
            return mode, bool(data.get("show_intermediate_replies", False))
    except Exception:
        return "all", False


async def im_user_locale(user_id) -> str:
    """读取用户界面语言，偏好缺失或不可用时使用简体中文。"""
    from app.db import session as db_session
    from app.services.user_preferences import get_user_locale

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return "zh-CN"
        async with db_session._SessionLocal() as db:
            locale = await get_user_locale(db, user_id)
        return locale if locale in {"zh-CN", "ja-JP", "en-US"} else "zh-CN"
    except Exception:
        return "zh-CN"


async def im_mermaid_theme_preferences(user_id) -> dict[str, str]:
    """读取 Mermaid 图片渲染需要的主题偏好；异常时使用默认浅色主题。"""
    from sqlalchemy import select
    from app.db import session as db_session
    from app.models import UserPreferences

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return {}
        async with db_session._SessionLocal() as db:
            row = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
            data = (row.data or {}) if row else {}
        return {
            "theme": data.get("theme") if data.get("theme") in {"light", "dark", "system"} else "light",
            "themeFamily": data.get("theme_family") if data.get("theme_family") in {"glass", "mono"} else "glass",
            "palette": data.get("palette") if data.get("palette") in {"mist", "cafe", "rose", "sky", "sage"} else "mist",
        }
    except Exception:
        return {}


async def show_intermediate_replies(user_id) -> bool:
    """读取 IM 中间轮次回复展示偏好；缺少设置时默认关闭。"""
    return (await im_display_preferences(user_id))[1]


async def decision_guard_enabled(user_id) -> bool:
    """读取用户主动开启的行动跟进守卫；读取失败或未设置时关闭。"""
    from sqlalchemy import select
    from app.db import session as db_session
    from app.models import UserPreferences

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return False
        async with db_session._SessionLocal() as db:
            row = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
            data = (row.data or {}) if row else {}
            return bool(data.get("decision_guard_enabled", False))
    except Exception:
        return False


__all__ = ["im_display_preferences", "show_intermediate_replies", "decision_guard_enabled"]
