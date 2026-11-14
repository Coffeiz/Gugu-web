"""Persist encrypted Node Agent run checkpoints and event outbox."""

from alembic import op
import sqlalchemy as sa


revision = "20261115000002"
down_revision = "20261115000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_run_checkpoints",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("phase", sa.String(length=20), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "session_id", "run_id"),
    )
    op.create_table(
        "agent_run_events",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("event_id", sa.String(length=128), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id", "session_id", "run_id"],
            ["agent_run_checkpoints.user_id", "agent_run_checkpoints.session_id", "agent_run_checkpoints.run_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "session_id", "run_id", "event_id"),
        sa.UniqueConstraint("user_id", "session_id", "run_id", "sequence", name="uq_agent_run_events_sequence"),
    )
    op.create_index(
        "ix_agent_run_events_pending",
        "agent_run_events",
        ["user_id", "session_id", "run_id", "sequence"],
        postgresql_where=sa.text("acknowledged_at IS NULL"),
    )
    op.create_table(
        "agent_run_interaction_receipts",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("receipt", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id", "session_id", "run_id"],
            ["agent_run_checkpoints.user_id", "agent_run_checkpoints.session_id", "agent_run_checkpoints.run_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "session_id", "run_id", "receipt"),
    )


def downgrade() -> None:
    op.drop_table("agent_run_interaction_receipts")
    op.drop_index("ix_agent_run_events_pending", table_name="agent_run_events")
    op.drop_table("agent_run_events")
    op.drop_table("agent_run_checkpoints")
