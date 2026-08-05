"""保存定时任务的固定 IM 投递目标。"""

from alembic import op


revision = "20260804000004"
down_revision = "20260804000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS delivery_targets JSON"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS delivery_targets"
    )
