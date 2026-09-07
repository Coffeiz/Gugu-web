"""为定时任务增加类型、精确间隔和可选时间窗口，并一次性回填旧数据。"""
from __future__ import annotations

from datetime import datetime, timezone
import re
from zoneinfo import ZoneInfo

from alembic import op
import sqlalchemy as sa
from apscheduler.triggers.cron import CronTrigger

SCHEDULE_TZ = ZoneInfo("Asia/Shanghai")

revision = "20260905000004"
down_revision = "20260904000001"
branch_labels = None
depends_on = None

_ONCE_PREFIX = "@once:"
_INTERVAL_RE = re.compile(r"^\*/([1-9][0-9]?) \* \* \* \*$")


def _as_utc(value: datetime) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_once(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise RuntimeError("invalid once datetime") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SCHEDULE_TZ)
    return parsed.astimezone(timezone.utc)


def _interval_anchor(created_at) -> datetime:
    if created_at is None:
        raise RuntimeError("interval task has no created_at")
    created_at = _as_utc(created_at).astimezone(SCHEDULE_TZ)
    return created_at.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def _once_cron(start_at: datetime) -> str:
    return f"@once:{start_at.astimezone(timezone.utc).isoformat()}"


def _classify(cron: str, created_at) -> tuple[str, int | None, datetime | None]:
    if (cron or "").startswith(_ONCE_PREFIX):
        return "once", None, _parse_once(cron[len(_ONCE_PREFIX):])
    match = _INTERVAL_RE.fullmatch((cron or "").strip())
    if match:
        minutes = int(match.group(1))
        if not 1 <= minutes <= 60:
            raise RuntimeError("interval is outside 1-60 minutes")
        return "interval", minutes, _interval_anchor(created_at)
    try:
        CronTrigger.from_crontab(cron)
    except Exception as exc:
        raise RuntimeError("invalid cron expression") from exc
    return "cron", None, None


def _add_column_if_missing(bind, name: str, column: sa.Column) -> None:
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if name not in columns:
        op.add_column("scheduled_tasks", column)


def _backfill(bind) -> None:
    rows = bind.execute(sa.text(
        "SELECT id, cron, created_at, schedule_kind, interval_minutes, start_at "
        "FROM scheduled_tasks ORDER BY id"
    )).mappings().all()
    update = sa.text(
        "UPDATE scheduled_tasks SET cron = :cron, schedule_kind = :schedule_kind, "
        "interval_minutes = :interval_minutes, start_at = :start_at WHERE id = :id"
    ).bindparams(sa.bindparam("start_at", type_=sa.DateTime(timezone=True)))
    for row in rows:
        # 已经完成回填的行不重新计算锚点，确保脚本可重入且不改变执行状态。
        if row["schedule_kind"] in {"cron", "interval", "once"} and (
            row["schedule_kind"] != "cron"
            or row["interval_minutes"] is not None
            or row["start_at"] is not None
        ):
            continue
        kind, interval, start_at = _classify(row["cron"], row["created_at"])
        bind.execute(update, {
            "id": row["id"],
            "cron": _once_cron(start_at) if kind == "once" else row["cron"],
            "schedule_kind": kind,
            "interval_minutes": interval,
            "start_at": start_at,
        })


def _validate_legacy_rows(bind) -> None:
    """先验证旧值，再执行 DDL；SQLite 的 ALTER TABLE 可能不随事务回滚。"""
    rows = bind.execute(sa.text(
        "SELECT id, cron, created_at FROM scheduled_tasks ORDER BY id"
    )).mappings().all()
    for row in rows:
        _classify(row["cron"], row["created_at"])


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "schedule_kind" not in columns:
        _validate_legacy_rows(bind)
    _add_column_if_missing(
        bind, "schedule_kind",
        sa.Column("schedule_kind", sa.String(length=16), nullable=False, server_default="cron"),
    )
    _add_column_if_missing(
        bind, "interval_minutes",
        sa.Column("interval_minutes", sa.Integer(), nullable=True),
    )
    _add_column_if_missing(
        bind, "start_at",
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
    )
    _add_column_if_missing(
        bind, "end_at",
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=True),
    )
    _backfill(bind)
    indexes = {item["name"] for item in sa.inspect(bind).get_indexes("scheduled_tasks")}
    if "ix_scheduled_tasks_schedule_kind" not in indexes:
        op.create_index("ix_scheduled_tasks_schedule_kind", "scheduled_tasks", ["schedule_kind"])
    if "ix_scheduled_tasks_end_at" not in indexes:
        op.create_index("ix_scheduled_tasks_end_at", "scheduled_tasks", ["end_at"])


def downgrade() -> None:
    bind = op.get_bind()
    indexes = {item["name"] for item in sa.inspect(bind).get_indexes("scheduled_tasks")}
    if "ix_scheduled_tasks_end_at" in indexes:
        op.drop_index("ix_scheduled_tasks_end_at", table_name="scheduled_tasks")
    if "ix_scheduled_tasks_schedule_kind" in indexes:
        op.drop_index("ix_scheduled_tasks_schedule_kind", table_name="scheduled_tasks")
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    for name in ("end_at", "start_at", "interval_minutes", "schedule_kind"):
        if name in columns:
            op.drop_column("scheduled_tasks", name)
