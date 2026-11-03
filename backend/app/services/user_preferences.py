"""用户偏好的只读业务查询。"""

from __future__ import annotations

import json

from sqlalchemy import select

from app.models import UserPreferences


IM_TOOL_DISPLAY_MODES = frozenset({"off", "all", "slow_only"})
THEME_PALETTES = frozenset({"cafe", "neutral", "red", "blue", "green"})
_LEGACY_THEME_PALETTES = {
    "mist": "blue", "rose": "red", "sky": "blue", "sage": "green",
    "lavender": "blue", "amber": "neutral", "aero": "blue", "mono": "neutral",
    "coral": "red", "teal": "green",
}


def normalize_theme_palette(value: object) -> str:
    """把旧主题偏好映射到当前完整色板；未知值使用中性色。"""
    if isinstance(value, str) and value in THEME_PALETTES:
        return value
    return _LEGACY_THEME_PALETTES.get(value, "neutral") if isinstance(value, str) else "neutral"


def normalize_im_tool_display_mode(value: object) -> str:
    """规范化三档 IM 工具展示模式；无效值采用默认的全部展示。"""
    return value if isinstance(value, str) and value in IM_TOOL_DISPLAY_MODES else "all"


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
