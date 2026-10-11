"""Add persisted incremental filesync baseline and reconciliation runs.

Revision ID: 20261006000001
Revises: 20261004000003
"""
from alembic import op
import sqlalchemy as sa


revision = "20261006000001"
down_revision = "20261004000003"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    journal_columns = _columns("file_sync_journal")
    if "dirty_revision" not in journal_columns:
        op.add_column(
            "file_sync_journal",
            sa.Column("dirty_revision", sa.Integer(), nullable=True),
        )
    op.create_index(
        "ix_file_sync_journal_dirty_revision", "file_sync_journal",
        ["binding_id", "dirty_revision"], if_not_exists=True,
    )

    binding_columns = _columns("file_sync_bindings")
    additions = (
        ("scope_revision", sa.Integer(), "0"),
        ("dirty_revision", sa.Integer(), "0"),
        ("baseline_dirty_revision", sa.Integer(), "0"),
        ("baseline_generation", sa.String(length=36), None),
        ("last_daily_reconciled_at", sa.DateTime(timezone=True), None),
        ("last_integrity_verified_at", sa.DateTime(timezone=True), None),
        ("next_reconcile_at", sa.DateTime(timezone=True), None),
        ("consecutive_failures", sa.Integer(), "0"),
    )
    for name, column_type, default in additions:
        if name in binding_columns:
            continue
        options = {"nullable": name not in {
            "scope_revision", "dirty_revision", "consecutive_failures",
        }}
        if default is not None:
            options["server_default"] = default
        op.add_column("file_sync_bindings", sa.Column(name, column_type, **options))

    op.create_table(
        "file_sync_reconcile_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("binding_id", sa.Integer(), nullable=False),
        sa.Column("mode", sa.String(length=24), nullable=False),
        sa.Column("reason", sa.String(length=24), nullable=False),
        sa.Column("dry_run", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("allow_delete", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("status", sa.String(length=24), server_default="queued", nullable=False),
        sa.Column("stage", sa.String(length=40), nullable=True),
        sa.Column("binding_revision", sa.Integer(), server_default="0", nullable=False),
        sa.Column("dirty_revision", sa.Integer(), server_default="0", nullable=False),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("slice_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cumulative_runtime_seconds", sa.Float(), server_default="0", nullable=False),
        sa.Column("pause_reason", sa.String(length=64), nullable=True),
        sa.Column("priority_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checkpoint_ref", sa.String(length=500), nullable=True),
        sa.Column("candidate_generation", sa.String(length=36), nullable=True),
        sa.Column("progress_current", sa.Integer(), server_default="0", nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=True),
        sa.Column("result_counts", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["binding_id"], ["file_sync_bindings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        if_not_exists=True,
    )
    op.create_index(
        "ix_file_sync_reconcile_runs_user_id", "file_sync_reconcile_runs", ["user_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_file_sync_reconcile_runs_binding_id", "file_sync_reconcile_runs", ["binding_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_file_sync_reconcile_runs_status", "file_sync_reconcile_runs", ["status"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_file_sync_reconcile_claim", "file_sync_reconcile_runs",
        ["status", "lease_until", "created_at"], if_not_exists=True,
    )
    op.create_index(
        "uq_file_sync_reconcile_active_binding", "file_sync_reconcile_runs", ["binding_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running', 'paused', 'cancelling')"),
        sqlite_where=sa.text("status IN ('queued', 'running', 'paused', 'cancelling')"),
        if_not_exists=True,
    )

    op.create_table(
        "file_sync_user_scan_states",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("activity_seq", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_file_activity_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("previous_cycle_cutoff", sa.DateTime(timezone=True), nullable=True),
        sa.Column("current_cycle_cutoff", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cycle_activity_seq", sa.Integer(), server_default="0", nullable=False),
        sa.Column("activity_reliable", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("last_cycle_decision", sa.String(length=32), nullable=True),
        sa.Column("skip_reason", sa.String(length=64), nullable=True),
        sa.Column("last_rotation_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_binding_rotation_id", sa.Integer(), nullable=True),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        if_not_exists=True,
    )


def downgrade() -> None:
    # 已发布快照与任务事实可能用于恢复，不自动删除生产数据。
    pass
