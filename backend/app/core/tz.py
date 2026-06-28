"""全局时区：优先使用机器本地时区，取不到回退北京时间（UTC+8）。

所有需要「当前本地时间 / 今日 0 点 / 按本地日期分组」的地方统一从此取，
不要在各模块里各自硬编码 timedelta(hours=8)。

用法：
    from app.core.tz import LOCAL_TZ, local_now, local_day_start_utc

    now    = local_now()                      # 本地当前时刻（带时区）
    start  = local_day_start_utc()            # 本地今日 0 点，转为 UTC naive，供 DB 比较
    today  = local_now().strftime("%Y-%m-%d") # 本地日期字符串
"""
from datetime import datetime, timezone, timedelta


def _detect() -> timezone:
    try:
        offset = datetime.now().astimezone().utcoffset()
        if offset is not None:
            return timezone(offset)
    except Exception:
        pass
    return timezone(timedelta(hours=8))  # 回退：北京时间


LOCAL_TZ: timezone = _detect()


def local_now() -> datetime:
    """返回本地当前时刻（timezone-aware）。"""
    return datetime.now(LOCAL_TZ)


def local_day_start_utc() -> datetime:
    """本地今日 0 点，转为 UTC naive datetime，供与数据库 UTC 字段比较。"""
    now = local_now()
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return day0.astimezone(timezone.utc).replace(tzinfo=None)


def fmt_local(dt, fmt: str = "%Y-%m-%d %H:%M") -> str:
    """UTC-naive datetime → 本地时间格式化字符串（供 API 直接下发给前端的时间字段）。"""
    if dt is None:
        return ""
    return dt.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ).strftime(fmt)


def utc_to_local_date_expr() -> str:
    """PostgreSQL 表达式：把 UTC 时间戳转成本地日期，用于 GROUP BY DATE(...)。
    例：DATE(created_at + INTERVAL '8 hours')"""
    offset_hours = int(LOCAL_TZ.utcoffset(None).total_seconds() // 3600)
    sign = "+" if offset_hours >= 0 else "-"
    return f"INTERVAL '{sign}{abs(offset_hours)} hours'"
