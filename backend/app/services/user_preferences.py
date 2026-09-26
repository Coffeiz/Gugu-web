"""用户偏好的只读业务查询。"""

from __future__ import annotations

import json

from sqlalchemy import select

from app.models import UserPreferences


async def read_user_preference_data(db, user_id) -> dict:
    data_json = await db.scalar(
        select(UserPreferences.data_json).where(UserPreferences.user_id == user_id)
    )
    try:
        data = json.loads(data_json or "{}")
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


async def get_user_locale(db, user_id) -> str | None:
    """读取用户保存的界面语言；配置损坏时返回空值交给调用方采用默认值。"""
    return (await read_user_preference_data(db, user_id)).get("locale")


async def effective_automatic_mode_enabled(db, user_id) -> bool:
    """新语义默认关闭；不继承历史 Shell 自动模式偏好。"""
    return bool((await read_user_preference_data(db, user_id)).get("automatic_mode_enabled", False))
