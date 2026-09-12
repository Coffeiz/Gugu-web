"""将 Web 会话待发消息持久化到数据库。"""

from alembic import op
import sqlalchemy as sa


revision = "20260912000001"
down_revision = "20260910000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversation_pending_queues",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("queue_id", sa.String(length=64), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=True),
        sa.Column("items", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "queue_id", name="uq_conversation_pending_queue_owner_key"),
    )
    op.create_index(
        "ix_conversation_pending_queues_user_id",
        "conversation_pending_queues",
        ["user_id"],
    )
    op.create_index(
        "ix_conversation_pending_queues_session_id",
        "conversation_pending_queues",
        ["session_id"],
    )
    op.create_index(
        "ix_conversation_pending_queues_queue_id",
        "conversation_pending_queues",
        ["queue_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_pending_queues_queue_id", table_name="conversation_pending_queues")
    op.drop_index("ix_conversation_pending_queues_session_id", table_name="conversation_pending_queues")
    op.drop_index("ix_conversation_pending_queues_user_id", table_name="conversation_pending_queues")
    op.drop_table("conversation_pending_queues")
