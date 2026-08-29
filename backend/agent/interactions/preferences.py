"""交互展示偏好。

偏好只控制 IM 的可见呈现，不参与工具执行、权限判断或确认消费。
"""
from __future__ import annotations


async def show_tool_interactions(user_id) -> bool:
    """读取用户的工具交互显示开关；读取失败按关闭处理。"""
    from sqlalchemy import select
    from app.db import session as db_session
    from app.models import UserPreferences

    try:
        db_session.ensure_engine()
        if db_session._SessionLocal is None:
            return False
        async with db_session._SessionLocal() as db:
            row = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
            return bool(row and (row.data or {}).get("show_tool_interactions", False))
    except Exception:
        return False


__all__ = ["show_tool_interactions"]
