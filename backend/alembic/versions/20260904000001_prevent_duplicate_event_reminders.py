"""防止同一活动同一触发时刻重复创建提醒。"""
from alembic import op

revision = "20260904000001"
down_revision = "20260902000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # event_id 为空的独立定时任务不参与约束；已有重复数据需要先人工核对后再执行迁移。
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_tasks_event_fire "
        "ON scheduled_tasks (user_id, event_id, cron) "
        "WHERE event_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_scheduled_tasks_event_fire")
