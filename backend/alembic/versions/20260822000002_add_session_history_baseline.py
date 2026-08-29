"""为会话历史增加连续追加 baseline 水位。"""

from alembic import op
import sqlalchemy as sa


revision = "20260822000002"
down_revision = "20260822000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_sessions",
        sa.Column("baseline_message_id", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "conversation_sessions",
        sa.Column("baseline_message_hash", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_conversation_sessions_baseline_message_id",
        "conversation_sessions",
        ["baseline_message_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversation_sessions_baseline_message_id",
        table_name="conversation_sessions",
    )
    op.drop_column("conversation_sessions", "baseline_message_hash")
    op.drop_column("conversation_sessions", "baseline_message_id")
