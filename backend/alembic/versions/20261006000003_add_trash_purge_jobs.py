"""Add persistent trash purge jobs."""

from alembic import op
import sqlalchemy as sa


revision = "20261006000003"
down_revision = "20261006000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trash_purge_jobs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("snapshot_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("progress_current", sa.Integer(), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=False),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_trash_purge_jobs_user_id", "trash_purge_jobs", ["user_id"])
    op.create_index("ix_trash_purge_jobs_status", "trash_purge_jobs", ["status"])
    op.create_index("ix_trash_purge_jobs_created_at", "trash_purge_jobs", ["created_at"])
    op.create_index(
        "ix_trash_purge_jobs_claim", "trash_purge_jobs",
        ["status", "lease_until", "created_at"],
    )
    op.create_index(
        "uq_trash_purge_jobs_user_active", "trash_purge_jobs", ["user_id"],
        unique=True, postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.create_index(
        "uq_trash_purge_jobs_global_running", "trash_purge_jobs", ["status"],
        unique=True, postgresql_where=sa.text("status = 'running'"),
    )


def downgrade() -> None:
    op.drop_table("trash_purge_jobs")
