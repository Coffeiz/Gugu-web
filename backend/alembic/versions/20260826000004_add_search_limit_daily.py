"""补齐每日联网搜索额度字段，供生产迁移步骤统一执行。"""

from alembic import op


revision = "20260826000004"
down_revision = "20260826000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS search_limit_daily INTEGER NULL"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS search_limit_daily")
