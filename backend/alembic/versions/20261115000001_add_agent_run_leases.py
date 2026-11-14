"""Add fenced PostgreSQL leases for Node Agent runs."""

from alembic import op
import sqlalchemy as sa


revision = "20261115000001"
down_revision = "20261109000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_run_leases",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("fence", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "session_id"),
    )
    op.create_index("ix_agent_run_leases_expires_at", "agent_run_leases", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_agent_run_leases_expires_at", table_name="agent_run_leases")
    op.drop_table("agent_run_leases")
