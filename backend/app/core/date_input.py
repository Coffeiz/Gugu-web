"""面向模型和表单输入的日期归一化。

所有只表达「哪一天」的业务字段统一落成 YYYY-MM-DD；不处理时分秒，
也不负责 cron/@once 这类带执行时间语义的字段。
"""
from __future__ import annotations

import re
from datetime import date, datetime

from app.core.tz import LOCAL_TZ

_DATE_PARTS_RE = re.compile(r"^(\d{1,4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,4})$")
_MONTH_DAY_PARTS_RE = re.compile(r"^(\d{1,2})\s*[-/.]\s*(\d{1,2})$")
_MONTH_DAY_RE = re.compile(r"^(\d{1,2})\s*月\s*(\d{1,2})\s*日?$")
_YEAR_MONTH_DAY_RE = re.compile(r"^(\d{1,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$")


def _year(value: str) -> int:
    number = int(value)
    return number + 2000 if len(value) == 2 else number


def parse_flexible_date(value: str, *, default_year: int | None = None) -> date:
    """解析常见模型日期写法，返回日期对象。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("日期不能为空")
    text = value.strip()
    year = default_year or datetime.now(LOCAL_TZ).year

    match = _YEAR_MONTH_DAY_RE.fullmatch(text)
    if match:
        return date(_year(match.group(1)), int(match.group(2)), int(match.group(3)))

    match = _MONTH_DAY_RE.fullmatch(text)
    if match:
        return date(year, int(match.group(1)), int(match.group(2)))

    match = _MONTH_DAY_PARTS_RE.fullmatch(text)
    if match:
        return date(year, int(match.group(1)), int(match.group(2)))

    match = _DATE_PARTS_RE.fullmatch(text)
    if not match:
        raise ValueError("日期格式无法识别")

    first, second, third = match.groups()
    values = [int(first), int(second), int(third)]
    candidates: list[tuple[int, int, int]] = []
    # 先尝试 MM-DD-YY/YYYY，失败后尝试 YY/YYYY-MM-DD，兼容年份前后。
    if len(third) in {2, 4} or values[2] > 31:
        candidates.append((_year(third), values[0], values[1]))
    if len(first) in {2, 4} or values[0] > 31:
        candidates.append((_year(first), values[1], values[2]))
    for candidate_year, month, day in candidates:
        try:
            return date(candidate_year, month, day)
        except ValueError:
            continue
    raise ValueError("日期格式无法识别")


def normalize_date_string(value: str, *, default_year: int | None = None) -> str:
    """把日期输入归一为 Schema 和业务层共用的 YYYY-MM-DD。"""
    return parse_flexible_date(value, default_year=default_year).isoformat()

