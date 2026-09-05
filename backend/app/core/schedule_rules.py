"""定时任务调度类型、时间窗口和字段组合的共享规则。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger

from app.core.tz import now_utc

SCHEDULE_KINDS = {"cron", "interval", "once"}
INTERVAL_MINUTES_MIN = 1
INTERVAL_MINUTES_MAX = 60
SCHEDULE_TZ = ZoneInfo("Asia/Shanghai")


class ScheduleValidationError(ValueError):
    """可直接转换为 API/工具字段错误的调度配置错误。"""

    def __init__(self, message: str, field: str = "schedule"):
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class ScheduleSpec:
    schedule_kind: str
    cron: str | None
    interval_minutes: int | None
    start_at: datetime | None
    end_at: datetime | None


def parse_schedule_datetime(value, field: str, *, local_tz=SCHEDULE_TZ) -> datetime | None:
    """把 API 的本地 ISO 时间统一成 aware UTC。"""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ScheduleValidationError(f"{field} 必须是合法的 ISO 日期时间", field) from exc
    if not isinstance(value, datetime):
        raise ScheduleValidationError(f"{field} 必须是合法的 ISO 日期时间", field)
    if value.tzinfo is None:
        value = value.replace(tzinfo=local_tz)
    return value.astimezone(timezone.utc)


def normalize_schedule(
    *,
    schedule_kind: str,
    cron: str | None,
    interval_minutes: int | None,
    start_at,
    end_at,
    now: datetime | None = None,
) -> ScheduleSpec:
    """校验并规范化 API/工具输入。旧格式只在一次性迁移中解析。"""
    kind = schedule_kind
    if kind not in SCHEDULE_KINDS:
        raise ScheduleValidationError("schedule_kind 只能是 cron、interval 或 once", "schedule_kind")

    parsed_start = parse_schedule_datetime(start_at, "start_at")
    parsed_end = parse_schedule_datetime(end_at, "end_at")
    if parsed_start and parsed_end and parsed_end < parsed_start:
        raise ScheduleValidationError("end_at 不能早于 start_at", "end_at")
    current = now or now_utc()

    if kind == "once":
        if cron:
            raise ScheduleValidationError("once 类型不能设置 cron", "cron")
        if interval_minutes is not None:
            raise ScheduleValidationError("once 类型不能设置 interval_minutes", "interval_minutes")
        if parsed_start is None:
            raise ScheduleValidationError("once 类型必须设置 start_at", "start_at")
        if parsed_start <= current:
            raise ScheduleValidationError("once 任务的 start_at 必须晚于当前时间", "start_at")
        if parsed_end is not None:
            raise ScheduleValidationError("once 类型不能设置 end_at", "end_at")
        return ScheduleSpec(kind, f"@once:{parsed_start.isoformat()}", None, parsed_start, None)

    if kind == "cron":
        if interval_minutes is not None:
            raise ScheduleValidationError("cron 类型不能设置 interval_minutes", "interval_minutes")
        if not cron:
            raise ScheduleValidationError("cron 类型必须设置 cron", "cron")
        try:
            CronTrigger.from_crontab(cron)
        except Exception as exc:
            raise ScheduleValidationError(
                "cron 表达式非法（格式“分 时 日 月 周”）", "cron"
            ) from exc
        if parsed_end is not None and parsed_end <= current and parsed_start is None:
            raise ScheduleValidationError("仅设置 end_at 时，end_at 必须晚于当前时间", "end_at")
        return ScheduleSpec(kind, cron, None, parsed_start, parsed_end)

    if cron:
        raise ScheduleValidationError("interval 类型不能设置 cron", "cron")
    if isinstance(interval_minutes, bool) or not isinstance(interval_minutes, int):
        raise ScheduleValidationError("interval_minutes 必须是整数", "interval_minutes")
    if not INTERVAL_MINUTES_MIN <= interval_minutes <= INTERVAL_MINUTES_MAX:
        raise ScheduleValidationError("interval_minutes 必须在 1 到 60 之间", "interval_minutes")
    if parsed_end is not None and parsed_end <= current and parsed_start is None:
        raise ScheduleValidationError("仅设置 end_at 时，end_at 必须晚于当前时间", "end_at")
    return ScheduleSpec(kind, f"*/{interval_minutes} * * * *", interval_minutes, parsed_start, parsed_end)


def task_schedule_kind(task) -> str:
    """读取迁移后的规范任务类型。"""
    kind = task.schedule_kind
    if kind not in SCHEDULE_KINDS:
        raise ScheduleValidationError("数据库中的 schedule_kind 非法", "schedule_kind")
    return kind


def is_task_ended(task, now: datetime | None = None) -> bool:
    end_at = task.end_at
    if end_at is None or task_schedule_kind(task) == "once":
        return False
    current = now or now_utc()
    if end_at.tzinfo is None:
        end_at = end_at.replace(tzinfo=timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return end_at <= current


def schedule_status(task, now: datetime | None = None) -> str:
    if is_task_ended(task, now):
        return "ended"
    if not task.enabled:
        return "disabled"
    return "active"
