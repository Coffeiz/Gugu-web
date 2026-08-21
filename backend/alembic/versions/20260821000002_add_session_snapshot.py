"""增加 session snapshot、TTL 与消息时间线元数据。"""

from alembic import op


revision = "20260821000002"
down_revision = "20260817000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS context_epoch INTEGER NOT NULL DEFAULT 1"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS session_context JSON"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS session_info_hash VARCHAR(64)"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS snapshot_hash VARCHAR(64)"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS snapshot_message_id INTEGER"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS snapshot_updated_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS snapshot_expires_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS snapshot_last_run_id VARCHAR(64)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_sessions_snapshot_expires_at "
        "ON conversation_sessions (snapshot_expires_at)"
    )
    op.execute(
        "ALTER TABLE conversation_messages "
        "ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE conversation_messages "
        "ADD COLUMN IF NOT EXISTS sequence INTEGER"
    )
    op.execute(
        "ALTER TABLE conversation_messages "
        "ADD COLUMN IF NOT EXISTS run_id VARCHAR(64)"
    )
    op.execute("UPDATE conversation_messages SET sent_at = created_at WHERE sent_at IS NULL")
    op.execute("UPDATE conversation_messages SET sequence = id WHERE sequence IS NULL")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_messages_session_sequence "
        "ON conversation_messages (session_id, sequence)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_messages_run_id "
        "ON conversation_messages (run_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_run_id")
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_session_sequence")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS run_id")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS sequence")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS sent_at")
    op.execute("DROP INDEX IF EXISTS ix_conversation_sessions_snapshot_expires_at")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_last_run_id")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_expires_at")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_updated_at")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_message_id")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS snapshot_hash")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS session_info_hash")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS session_context")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS context_epoch")
