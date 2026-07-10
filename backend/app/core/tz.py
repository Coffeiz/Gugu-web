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


def now_utc() -> datetime:
    """当前 UTC 时间——统一时钟出口（见 docs/backend/时区与时钟迁移方案.md Phase 1）。

    业务代码禁止再直调已弃用的 `datetime.utcnow()`（Python 3.14 持续告警），一律走这里。
    **过渡期返回 naive UTC**：与现有全 naive 的 DateTime 列一致，零行为变化。等 Phase 2 把列
    迁成 `timestamptz` 后，这里去掉 `.replace(tzinfo=None)` 返回 aware 即可，不用再动调用点。
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
