"""清理未参与运行时语义的会话快照与消息元数据字段。"""

from alembic import op


revision = "20260821000004"
down_revision = "20260821000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_run_id")
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_session_sequence")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS run_id")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS sequence")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_last_run_id")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_updated_at")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_message_id")


def downgrade() -> None:
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS snapshot_message_id INTEGER")
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS snapshot_updated_at TIMESTAMPTZ")
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS snapshot_last_run_id VARCHAR(64)")
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS sequence INTEGER")
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS run_id VARCHAR(64)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_conversation_messages_session_sequence ON conversation_messages (session_id, sequence)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_conversation_messages_run_id ON conversation_messages (run_id)")
