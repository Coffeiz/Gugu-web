"""按用户时区的日期归属（Phase 3）——与前端 dateAttribution.ts 同口径。

全程显式传 tz + now，不依赖测试机时区（LOCAL_TZ），保证确定性。
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app.core.tz import (
    LOCAL_TZ, resolve_tz, user_tz, day_key, today_str, is_today, is_this_week,
)

SH = ZoneInfo("Asia/Shanghai")
NY = ZoneInfo("America/New_York")
UTC = timezone.utc


def test_resolve_tz():
    assert resolve_tz("Asia/Shanghai") == SH
    assert resolve_tz(None) is LOCAL_TZ           # 空 → 回退服务器 tz
    assert resolve_tz("") is LOCAL_TZ
    assert resolve_tz("Not/AZone") is LOCAL_TZ     # 非法名 → 回退，不当 UTC


def test_user_tz():
    class U:  # 有 timezone
        timezone = "America/New_York"
    class V:  # 无
        timezone = None
    assert user_tz(U()) == NY
    assert user_tz(V()) is LOCAL_TZ


def test_day_key_crosses_midnight_by_tz():
    assert day_key(datetime(2026, 7, 11, 20, 0, tzinfo=UTC), SH) == "2026-07-12"   # +8 跨到次日
    assert day_key(datetime(2026, 7, 11, 2, 0, tzinfo=UTC), NY) == "2026-07-10"    # -4 退到前日
    assert day_key(datetime(2026, 7, 11, 8, 0, tzinfo=UTC), UTC) == "2026-07-11"


def test_day_key_naive_treated_as_utc():
    assert day_key(datetime(2026, 7, 11, 20, 0), SH) == "2026-07-12"   # naive 按 UTC 解释


def test_is_today_tz_correctness():
    prev = datetime(2026, 7, 11, 15, 0, tzinfo=UTC)   # 上海 07-11 23:00
    after = datetime(2026, 7, 11, 16, 30, tzinfo=UTC)  # 上海 07-12 00:30
    assert is_today(prev, SH, now=after) is False      # 东八区跨午夜 → 不同天
    assert is_today(prev, UTC, now=after) is True       # UTC 口径同天


def test_is_this_week_monday_start():
    now = datetime(2026, 7, 8, 12, 0, tzinfo=UTC)      # 周三；本周 07-06(一)…07-12(日)
    at = lambda d: datetime(2026, 7, d, 12, 0, tzinfo=UTC)
    assert is_this_week(at(6), UTC, now=now) is True
    assert is_this_week(at(11), UTC, now=now) is True
    assert is_this_week(at(5), UTC, now=now) is False   # 上周日
    assert is_this_week(at(13), UTC, now=now) is False  # 下周一


def test_today_str_runs():
    assert len(today_str(SH)) == 10   # 'YYYY-MM-DD'
