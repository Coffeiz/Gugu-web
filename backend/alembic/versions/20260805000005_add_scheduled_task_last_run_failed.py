"""一次性定时任务补充 last_run_failed，区分"已成功"和"已尝试但失败"。

原来只有 last_run_at：执行前就写入，失败时从不清除，导致失败的一次性任务
既不会自动重试、无法再次正式执行，用户打开任务面板时又会被当成"过期"删掉。
"""

from alembic import op
import sqlalchemy as sa


revision = "20260805000005"
down_revision = "20260805000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS "
        "last_run_failed BOOLEAN"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS last_run_failed")
