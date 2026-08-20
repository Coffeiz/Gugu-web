"""验证动态上下文中的日期使用用户时区。"""
from datetime import datetime
from zoneinfo import ZoneInfo

from agent.context import builder
from app.core.tz import LOCAL_TZ


def test_build_today_uses_user_tz():
    sh = ZoneInfo("Asia/Shanghai")
    _, dynamic, now_str = builder.build_split("default", "u", [], [], user_tz=sh)
    today = datetime.now(sh).strftime("%Y-%m-%d")
    assert today in now_str
    assert today not in dynamic


def test_build_default_falls_back_to_server_tz():
    _, dynamic, now_str = builder.build_split("default", "u", [], [])
    today = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    assert today in now_str
    assert today not in dynamic
