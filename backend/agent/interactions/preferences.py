"""交互展示偏好。

偏好只控制 IM 的可见呈现，不参与工具执行、权限判断或确认消费。
缺少设置或暂时无法读取时，默认展示工具调用并隐藏中间轮次回复。
"""
from __future__ import annotations


async def im_display_preferences(user_id) -> tuple[bool, bool]:
    """一次读取 IM 展示偏好；缺失或读取失败时使用产品默认值。"""
    from sqlalchemy import select
    from app.db import session as db_session
    from app.models import UserPreferences

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return True, False
        async with db_session._SessionLocal() as db:
            row = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
            data = (row.data or {}) if row else {}
            return bool(data.get("show_tool_interactions", True)), bool(data.get("show_intermediate_replies", False))
    except Exception:
        return True, False


async def show_tool_interactions(user_id) -> bool:
    """读取用户的工具交互显示开关；缺少设置时默认开启。"""
    return (await im_display_preferences(user_id))[0]


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


__all__ = ["im_display_preferences", "show_tool_interactions", "show_intermediate_replies", "decision_guard_enabled"]
