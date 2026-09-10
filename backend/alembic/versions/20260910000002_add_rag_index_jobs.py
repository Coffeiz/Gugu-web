"""为 RAG 索引更新增加可恢复持久任务。"""
from alembic import op
import sqlalchemy as sa


revision = "20260910000002"
down_revision = "20260910000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rag_index_jobs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("source_id", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("version", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("operation", sa.String(length=24), nullable=False, server_default="upsert"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="queued"),
        sa.Column("generation", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("completed_generation", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(length=64), nullable=True),
        sa.Column("last_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_succeeded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "source_type", name="uq_rag_index_job_user_source"),
    )
    op.create_index("ix_rag_index_jobs_user_id", "rag_index_jobs", ["user_id"])
    op.create_index("ix_rag_index_jobs_status", "rag_index_jobs", ["status"])
    op.create_index("ix_rag_index_jobs_next_attempt_at", "rag_index_jobs", ["next_attempt_at"])
    op.create_index(
        "ix_rag_index_jobs_due",
        "rag_index_jobs",
        ["status", "next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_rag_index_jobs_due", table_name="rag_index_jobs")
    op.drop_index("ix_rag_index_jobs_next_attempt_at", table_name="rag_index_jobs")
    op.drop_index("ix_rag_index_jobs_status", table_name="rag_index_jobs")
    op.drop_index("ix_rag_index_jobs_user_id", table_name="rag_index_jobs")
    op.drop_table("rag_index_jobs")
