"""用户偏好的只读业务查询。"""

from __future__ import annotations

import json

from sqlalchemy import select

from app.models import UserPreferences


async def get_user_locale(db, user_id) -> str | None:
    """读取用户保存的界面语言；配置损坏时返回空值交给调用方采用默认值。"""
    data_json = await db.scalar(
        select(UserPreferences.data_json).where(UserPreferences.user_id == user_id)
    )
    try:
        data = json.loads(data_json or "{}")
    except (TypeError, ValueError):
        return None
    return data.get("locale") if isinstance(data, dict) else None
