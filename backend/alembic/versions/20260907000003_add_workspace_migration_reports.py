"""记录旧 Shell 目录迁移扫描结果。"""

from alembic import op
import sqlalchemy as sa


revision = "20260907000003"
down_revision = "20260907000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspace_migration_reports",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("source_directory", sa.String(length=500), nullable=False),
        sa.Column("target_directory", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=24), server_default=sa.text("'not_found'"), nullable=False),
        sa.Column("source_file_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("error_message", sa.String(length=500), nullable=True),
        sa.Column("scanned_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "source_directory", name="uq_workspace_migration_report_source"),
    )
    op.create_index("ix_workspace_migration_reports_user_id", "workspace_migration_reports", ["user_id"])
    op.create_index("ix_workspace_migration_reports_status", "workspace_migration_reports", ["status"])


def downgrade() -> None:
    op.drop_index("ix_workspace_migration_reports_status", table_name="workspace_migration_reports")
    op.drop_index("ix_workspace_migration_reports_user_id", table_name="workspace_migration_reports")
    op.drop_table("workspace_migration_reports")
