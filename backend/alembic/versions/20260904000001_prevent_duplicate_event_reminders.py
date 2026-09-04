"""防止同一活动同一触发时刻重复创建提醒。"""
from alembic import op
import sqlalchemy as sa

revision = "20260904000001"
down_revision = "20260902000005"
branch_labels = None
depends_on = None


def _merge_channels(values: list[str | None]) -> str:
    """合并历史重复任务的投递渠道，保留首次出现顺序并去重。"""
    merged: list[str] = []
    seen: set[str] = set()
    for value in values:
        for channel in (value or "").split(","):
            channel = channel.strip()
            if channel and channel not in seen:
                seen.add(channel)
                merged.append(channel)
    return ",".join(merged)


def _deduplicate_event_reminders(bind) -> None:
    """确定性合并已有活动提醒重复行，再创建唯一索引。"""
    rows = bind.execute(sa.text(
        "SELECT id, user_id, event_id, cron, channels "
        "FROM scheduled_tasks "
        "WHERE event_id IS NOT NULL "
        "ORDER BY id"
    )).mappings().all()
    groups: dict[tuple[object, object, object], list[dict]] = {}
    for row in rows:
        key = (row["user_id"], row["event_id"], row["cron"])
        groups.setdefault(key, []).append(dict(row))

    for duplicate_rows in groups.values():
        if len(duplicate_rows) < 2:
            continue
        keeper = duplicate_rows[0]
        merged_channels = _merge_channels([row["channels"] for row in duplicate_rows])
        if keeper["channels"] != merged_channels:
            bind.execute(
                sa.text("UPDATE scheduled_tasks SET channels = :channels WHERE id = :id"),
                {"channels": merged_channels, "id": keeper["id"]},
            )
        bind.execute(
            sa.text("DELETE FROM scheduled_tasks WHERE id IN "
                    "(" + ",".join(str(row["id"]) for row in duplicate_rows[1:]) + ")")
        )


def upgrade() -> None:
    bind = op.get_bind()
    # event_id 为空的独立定时任务不参与约束；历史活动提醒先按 id 确定性保留一条，
    # 并合并所有重复行的 channels，避免自动迁移因为旧重复数据直接失败。
    _deduplicate_event_reminders(bind)
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_tasks_event_fire "
        "ON scheduled_tasks (user_id, event_id, cron) "
        "WHERE event_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_scheduled_tasks_event_fire")
