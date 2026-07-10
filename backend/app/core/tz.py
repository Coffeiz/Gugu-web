"""全局时区：优先使用机器本地时区，取不到回退北京时间（UTC+8）。

所有需要「当前本地时间 / 今日 0 点 / 按本地日期分组」的地方统一从此取，
不要在各模块里各自硬编码 timedelta(hours=8)。

用法：
    from app.core.tz import LOCAL_TZ, local_now, local_day_start_utc

    now    = local_now()                      # 本地当前时刻（带时区）
    start  = local_day_start_utc()            # 本地今日 0 点，转为 UTC naive，供 DB 比较
    today  = local_now().strftime("%Y-%m-%d") # 本地日期字符串
"""
from datetime import datetime, timezone, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _detect() -> timezone:
    try:
        offset = datetime.now().astimezone().utcoffset()
        if offset is not None:
            return timezone(offset)
    except Exception:
        pass
    return timezone(timedelta(hours=8))  # 回退：北京时间


LOCAL_TZ: timezone = _detect()


def now_utc() -> datetime:
    """当前 UTC 时间（aware）——统一时钟出口（见 docs/backend/时区与时钟迁移方案.md）。

    业务代码禁止再直调已弃用的 `datetime.utcnow()`（Python 3.14 持续告警），一律走这里。
    Phase 2 起返回 **aware** UTC：所有 datetime 列走 `UtcDateTime`，进出都是 aware UTC，
    与本函数比较不再有 naive/aware 混用。
    """
    return datetime.now(timezone.utc)


def local_now() -> datetime:
    """返回本地当前时刻（timezone-aware）。"""
    return datetime.now(LOCAL_TZ)


def local_day_start_utc() -> datetime:
    """本地今日 0 点，转为 UTC（aware），供与数据库 UtcDateTime 字段比较。"""
    now = local_now()
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return day0.astimezone(timezone.utc)


def fmt_local(dt, fmt: str = "%Y-%m-%d %H:%M") -> str:
    """UTC datetime（aware 或 naive 都兼容）→ 本地时间格式化字符串（供 API 下发的时间字段）。"""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)   # 兜底：万一拿到 naive，按 UTC 解释
    return dt.astimezone(LOCAL_TZ).strftime(fmt)


def utc_to_local_date_expr() -> str:
    """PostgreSQL 表达式：把 UTC 时间戳转成本地日期，用于 GROUP BY DATE(...)。
    例：DATE(created_at + INTERVAL '8 hours')"""
    offset_hours = int(LOCAL_TZ.utcoffset(None).total_seconds() // 3600)
    sign = "+" if offset_hours >= 0 else "-"
    return f"INTERVAL '{sign}{abs(offset_hours)} hours'"


# ── 按用户时区的日期归属（Phase 3）──────────────────────────────────────────────
# 与前端 src/utils/dateAttribution.ts 同口径（周一起点）。datetime 列现在都是 aware UTC
# （UtcDateTime），这些函数把"绝对时刻"落到"某人本地的哪一天"。tz 缺省用服务器 LOCAL_TZ。

def resolve_tz(name: str | None) -> tzinfo:
    """IANA 时区名 → tzinfo；空/非法名回退服务器 LOCAL_TZ（不静默当 UTC）。"""
    if not name:
        return LOCAL_TZ
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return LOCAL_TZ


def user_tz(user) -> tzinfo:
    """用户的时区：User.timezone 有值就用，否则回退 LOCAL_TZ。"""
    return resolve_tz(getattr(user, "timezone", None))


def _as_aware_utc(instant: datetime) -> datetime:
    return instant if instant.tzinfo is not None else instant.replace(tzinfo=timezone.utc)


def day_key(instant: datetime, tz: tzinfo | None = None) -> str:
    """绝对时刻在 tz 下属于哪一天，返回 'YYYY-MM-DD'。naive 入参按 UTC 解释。"""
    return _as_aware_utc(instant).astimezone(tz or LOCAL_TZ).strftime("%Y-%m-%d")


def today_str(tz: tzinfo | None = None) -> str:
    """tz 下的今天 'YYYY-MM-DD'。"""
    return datetime.now(tz or LOCAL_TZ).strftime("%Y-%m-%d")


def is_today(instant: datetime, tz: tzinfo | None = None, now: datetime | None = None) -> bool:
    tz = tz or LOCAL_TZ
    now = now or datetime.now(timezone.utc)
    return day_key(instant, tz) == day_key(now, tz)


def _monday_of(day: str) -> datetime:
    d = datetime.strptime(day, "%Y-%m-%d")
    return d - timedelta(days=d.weekday())   # weekday(): 周一=0


def is_this_week(instant: datetime, tz: tzinfo | None = None, now: datetime | None = None) -> bool:
    """是否与 now 同一本地周（周一起点）。"""
    tz = tz or LOCAL_TZ
    now = now or datetime.now(timezone.utc)
    return _monday_of(day_key(instant, tz)) == _monday_of(day_key(now, tz))
