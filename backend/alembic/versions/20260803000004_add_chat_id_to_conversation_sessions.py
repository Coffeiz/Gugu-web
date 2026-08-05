"""记录 IM 群会话所属的 chat_id，限制群上下文搜索范围。"""

from alembic import op


revision = "20260803000004"
down_revision = "20260803000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS chat_id VARCHAR(128)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_sessions_chat_id "
        "ON conversation_sessions (chat_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_sessions_chat_id")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS chat_id")
