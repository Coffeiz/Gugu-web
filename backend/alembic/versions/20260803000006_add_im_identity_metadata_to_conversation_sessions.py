"""保存 IM 会话的发言人和会话类型。"""

from alembic import op


revision = "20260803000006"
down_revision = "20260803000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS platform_user_id VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS chat_type VARCHAR(20)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_sessions_platform_user_id "
        "ON conversation_sessions (platform_user_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_sessions_platform_user_id")
    op.execute(
        "ALTER TABLE conversation_sessions "
        "DROP COLUMN IF EXISTS chat_type"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "DROP COLUMN IF EXISTS platform_user_id"
    )
