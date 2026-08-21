"""验证动态上下文中的日期使用用户时区。"""
from datetime import datetime
from zoneinfo import ZoneInfo

from agent.context import builder
from agent.context.session_snapshot import date_boundary_note
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


def test_build_split_includes_default_profile_policy_in_static_prompt():
    static, dynamic, _ = builder.build_split("default", "u", [], [])
    assert "当前、最新、最近" in static
    assert "先用搜索核实" in static
    assert "当前、最新、最近" not in dynamic


def test_night_date_boundary_note_is_neutral():
    note = date_boundary_note(2)
    assert "日出前时段" in note
    assert "今天" in note and "明天" in note
    assert all(word not in note for word in ("未眠", "睡觉", "早点睡", "休息"))
    assert date_boundary_note(4) == ""
