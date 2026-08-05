"""删除已停用的定时任务 context_config 列。"""

from alembic import op


revision = "20260805000004"
down_revision = "20260805000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS context_config")


def downgrade() -> None:
    op.execute("ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS context_config JSON")
