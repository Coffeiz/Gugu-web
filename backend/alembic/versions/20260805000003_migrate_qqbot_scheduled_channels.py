"""迁移定时任务渠道中的历史 qqbot 标识。"""

from alembic import op


revision = "20260805000003"
down_revision = "20260805000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 独立定时任务和活动提醒共用 scheduled_tasks.channels。
    op.execute(
        "UPDATE scheduled_tasks SET channels = replace(channels, 'qqbot', 'qq') "
        "WHERE channels LIKE '%qqbot%'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE scheduled_tasks SET channels = replace(channels, 'qq', 'qqbot') "
        "WHERE channels LIKE '%qq%'"
    )
