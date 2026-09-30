"""独立保存活动提醒的提前分钟数，避免禁用期间配置随活动时间漂移。"""

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

from app.core.schedule_rules import SCHEDULE_TZ

revision = "20261001000001"
down_revision = "20260930000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "reminder_lead_minutes" not in columns:
        op.add_column("scheduled_tasks", sa.Column("reminder_lead_minutes", sa.Integer(), nullable=True))
    tasks = sa.table(
        "scheduled_tasks", sa.column("id", sa.Integer()), sa.column("event_id", sa.Integer()),
        sa.column("user_id"), sa.column("schedule_kind", sa.String()),
        sa.column("start_at", sa.DateTime(timezone=True)), sa.column("reminder_lead_minutes", sa.Integer()),
    )
    events = sa.table(
        "calendar_events", sa.column("id", sa.Integer()), sa.column("user_id"),
        sa.column("date", sa.String()), sa.column("time", sa.String()),
    )
    rows = bind.execute(sa.select(tasks.c.id, tasks.c.start_at, events.c.date, events.c.time).select_from(
        tasks.join(events, sa.and_(tasks.c.event_id == events.c.id, tasks.c.user_id == events.c.user_id))
    ).where(
        tasks.c.schedule_kind == "once", tasks.c.start_at.is_not(None),
        tasks.c.reminder_lead_minutes.is_(None),
    )).mappings().all()
    for row in rows:
        base = datetime.fromisoformat(f"{row['date']}T{row['time'] or '09:00'}")
        fire = row["start_at"]
        if fire.tzinfo is None:
            fire = fire.replace(tzinfo=timezone.utc)
        fire = fire.astimezone(SCHEDULE_TZ).replace(tzinfo=None)
        lead = round((base - fire).total_seconds() / 60)
        bind.execute(tasks.update().where(tasks.c.id == row["id"]).values(reminder_lead_minutes=lead))


def downgrade() -> None:
    op.drop_column("scheduled_tasks", "reminder_lead_minutes")
