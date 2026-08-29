"""为会话增加单任务执行状态与 pending 计数。"""

from alembic import op
import sqlalchemy as sa


revision = "20260824000004"
down_revision = "20260824000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_sessions",
        sa.Column("execution_state", sa.String(length=24), nullable=False, server_default="idle"),
    )
    op.add_column(
        "conversation_sessions",
        sa.Column("active_run_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "conversation_sessions",
        sa.Column("pending_message_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index(
        "ix_conversation_sessions_execution_state",
        "conversation_sessions",
        ["execution_state"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_sessions_execution_state", table_name="conversation_sessions")
    op.drop_column("conversation_sessions", "pending_message_count")
    op.drop_column("conversation_sessions", "active_run_id")
    op.drop_column("conversation_sessions", "execution_state")
