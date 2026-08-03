"""保存 QQ Bot 的 owner 平台身份。"""

from alembic import op


revision = "20260803000002"
down_revision = "20260803000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS owner_platform_user_id VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS owner_bound_at TIMESTAMPTZ"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS owner_bound_at")
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS owner_platform_user_id")
