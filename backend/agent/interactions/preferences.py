"""交互展示偏好。

偏好只控制 IM 的可见呈现，不参与工具执行、权限判断或确认消费。
"""
from __future__ import annotations


async def im_display_preferences(user_id) -> tuple[bool, bool]:
    """一次读取 IM 展示偏好，失败时分别按安全的旧默认值处理。"""
    from sqlalchemy import select
    from app.db import session as db_session
    from app.models import UserPreferences

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return False, True
        async with db_session._SessionLocal() as db:
            row = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
            data = (row.data or {}) if row else {}
            return bool(data.get("show_tool_interactions", False)), bool(data.get("show_intermediate_replies", True))
    except Exception:
        return False, True


async def show_tool_interactions(user_id) -> bool:
    """读取用户的工具交互显示开关；读取失败按关闭处理。"""
    return (await im_display_preferences(user_id))[0]


async def show_intermediate_replies(user_id) -> bool:
    """读取 IM 中间轮次回复展示偏好；读取失败或未设置时保持旧行为。"""
    return (await im_display_preferences(user_id))[1]


__all__ = ["im_display_preferences", "show_tool_interactions", "show_intermediate_replies"]
