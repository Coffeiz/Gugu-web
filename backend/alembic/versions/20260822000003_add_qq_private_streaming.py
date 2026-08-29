"""为 QQ C2C 私聊增加官方流式回复开关。"""

from alembic import op


revision = "20260822000003"
down_revision = "20260822000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS "
        "private_streaming_enabled BOOLEAN NOT NULL DEFAULT FALSE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS private_streaming_enabled")
