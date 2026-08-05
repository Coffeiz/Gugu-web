"""修复定时任务表可能被错误标记为 head 但缺失的字段。"""

from alembic import op


revision = "20260805000001"
down_revision = "20260804000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 某些 devserver 数据库曾在迁移未完整执行时被直接 stamp 到 head。
    # 这里用幂等 DDL 修复真实结构，不影响已经存在的字段和任务数据。
    op.execute(
        "ALTER TABLE scheduled_tasks "
        "ADD COLUMN IF NOT EXISTS context_config JSON"
    )
    op.execute(
        "ALTER TABLE scheduled_tasks "
        "ADD COLUMN IF NOT EXISTS delivery_targets JSON"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS delivery_targets")
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS context_config")
