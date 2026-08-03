"""保存消息中明确识别出的 QQ Bot mention ID。"""

from alembic import op


revision = "20260804000002"
down_revision = "20260804000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS "
        "platform_bot_user_id VARCHAR(128)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_messages_platform_bot_user_id "
        "ON conversation_messages (platform_bot_user_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_platform_bot_user_id")
    op.execute(
        "ALTER TABLE conversation_messages DROP COLUMN IF EXISTS platform_bot_user_id"
    )
