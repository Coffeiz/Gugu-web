"""当前时间工具。"""
from __future__ import annotations

from agent.tools.base import BaseSkill, Tool
from app.core.tz import now_ctx


_WEEKDAYS = "一二三四五六日"


async def _get_current_time(_db, _user_id, _args: dict) -> dict:
    """按当前请求绑定的用户时区返回实时日期、星期和时间。"""
    current = now_ctx()
    return {
        "date": current.strftime("%Y-%m-%d"),
        "weekday": f"星期{_WEEKDAYS[current.weekday()]}",
        "time": current.strftime("%H:%M:%S"),
        "datetime": current.strftime("%Y-%m-%d %H:%M:%S"),
        "timezone": getattr(current.tzinfo, "key", None) or str(current.tzinfo),
    }


class TimeSkill(BaseSkill):
    name = "time"
    tools = [
        Tool(
            name="get_current_time",
            label="获取当前时间",
            description_short="获取当前日期、星期和时间。",
            description="返回当前请求用户时区下的日期、星期、时间和完整时间戳。用户询问现在日期、星期或准确时间时调用，不要用消息时间代替实时当前时间。",
            input_schema={"type": "object", "properties": {}},
            handler=_get_current_time,
        ),
    ]


TimeSkill().register()
