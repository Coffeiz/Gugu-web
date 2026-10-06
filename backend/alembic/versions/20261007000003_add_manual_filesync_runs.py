"""增加手动异步文件对账的最小持久任务模型。

此修订已应用于 devserver；保留它以维持 Alembic 修订图连续。
下一修订将把结构恢复到当前文件同步代码使用的快照模型。
"""

from alembic import op
import sqlalchemy as sa


revision = "20261007000003"
down_revision = "20261007000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "file_sync_reconcile_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("binding_id", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(length=24), nullable=False),
        sa.Column("allow_delete", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("status", sa.String(length=24), server_default="queued", nullable=False),
        sa.Column("stage", sa.String(length=24), nullable=True),
        sa.Column("binding_revision", sa.Integer(), server_default="0", nullable=False),
        sa.Column("gap_revision", sa.Integer(), server_default="0", nullable=False),
        sa.Column("root_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("scanned_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("result_counts", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["binding_id"], ["file_sync_bindings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_file_sync_reconcile_runs_user_id", "file_sync_reconcile_runs", ["user_id"])
    op.create_index("ix_file_sync_reconcile_runs_binding_id", "file_sync_reconcile_runs", ["binding_id"])
    op.create_index("ix_file_sync_reconcile_runs_status", "file_sync_reconcile_runs", ["status"])
    op.create_index(
        "ix_file_sync_reconcile_runs_claim", "file_sync_reconcile_runs", ["status", "created_at"]
    )
    op.create_index(
        "ix_file_sync_reconcile_runs_user_created", "file_sync_reconcile_runs", ["user_id", "created_at"]
    )
    op.create_index(
        "uq_file_sync_reconcile_active_binding", "file_sync_reconcile_runs", ["binding_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running', 'cancelling')"),
        sqlite_where=sa.text("status IN ('queued', 'running', 'cancelling')"),
    )
    op.create_index(
        "uq_file_sync_reconcile_running_user", "file_sync_reconcile_runs", ["user_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('running', 'cancelling')"),
        sqlite_where=sa.text("status IN ('running', 'cancelling')"),
    )


def downgrade() -> None:
    op.drop_table("file_sync_reconcile_runs")
