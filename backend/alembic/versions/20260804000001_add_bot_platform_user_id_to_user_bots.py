"""保存 QQ Bot 的平台身份 ID，用于精确解析 @机器人。"""

from alembic import op


revision = "20260804000001"
down_revision = "20260803000008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS "
        "bot_platform_user_id VARCHAR(128)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS bot_platform_user_id")
