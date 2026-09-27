"""为 canonical 对话消息记录 run/round 归属。"""
from alembic import op


revision = "20260927000001"
down_revision = "20260916000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS run_id VARCHAR(128) NULL")
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS round_id VARCHAR(64) NULL")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conversation_messages_run_id "
        "ON conversation_messages (run_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_run_id")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS round_id")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS run_id")
