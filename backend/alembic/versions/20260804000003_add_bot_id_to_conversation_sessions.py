"""按 IM Bot 隔离会话作用域。"""

from alembic import op


revision = "20260804000003"
down_revision = "20260804000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS "
        "bot_id VARCHAR(128)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_sessions_bot_id "
        "ON conversation_sessions (bot_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_sessions_bot_id")
    op.execute(
        "ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS bot_id"
    )
