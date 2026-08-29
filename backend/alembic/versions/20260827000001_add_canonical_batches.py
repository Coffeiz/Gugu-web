"""为会话历史增加 Canonical batch 身份。"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260827000001"
down_revision = "20260826000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversation_batches",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Integer(),
            sa.ForeignKey("conversation_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=True),
        sa.Column("round_id", sa.String(length=64), nullable=True),
        sa.Column("digest", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("session_id", "digest", name="uq_conversation_batches_session_digest"),
    )
    op.create_index(
        "ix_conversation_batches_session_round",
        "conversation_batches",
        ["session_id", "round_id"],
    )
    op.add_column(
        "conversation_messages",
        sa.Column(
            "canonical_batch_id",
            sa.BigInteger(),
            sa.ForeignKey("conversation_batches.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_conversation_messages_canonical_batch_id",
        "conversation_messages",
        ["canonical_batch_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_messages_canonical_batch_id", table_name="conversation_messages")
    op.drop_column("conversation_messages", "canonical_batch_id")
    op.drop_index("ix_conversation_batches_session_round", table_name="conversation_batches")
    op.drop_table("conversation_batches")
