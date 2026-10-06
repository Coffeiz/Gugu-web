"""恢复当前文件同步代码所需的快照与对账表结构。

旧版快照数据已经由 20261007000001 清理，恢复后以空基线启动，后续扫描会重建基线。
"""

from alembic import op
import sqlalchemy as sa


revision = "20261007000004"
down_revision = "20261007000003"
branch_labels = None
depends_on = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def _restore_binding_columns() -> None:
    additions = (
        ("scope_revision", sa.Integer(), "0", False),
        ("dirty_revision", sa.Integer(), "0", False),
        ("baseline_dirty_revision", sa.Integer(), "0", False),
        ("baseline_generation", sa.String(length=36), None, True),
        ("last_daily_reconciled_at", sa.DateTime(timezone=True), None, True),
        ("last_integrity_verified_at", sa.DateTime(timezone=True), None, True),
        ("next_reconcile_at", sa.DateTime(timezone=True), None, True),
        ("consecutive_failures", sa.Integer(), "0", False),
    )
    present = _columns("file_sync_bindings")
    for name, column_type, default, nullable in additions:
        if name in present:
            continue
        options = {"nullable": nullable}
        if default is not None:
            options["server_default"] = default
        op.add_column("file_sync_bindings", sa.Column(name, column_type, **options))


def _restore_journal_column() -> None:
    if "dirty_revision" not in _columns("file_sync_journal"):
        op.add_column(
            "file_sync_journal",
            sa.Column("dirty_revision", sa.Integer(), nullable=True),
        )
    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("file_sync_journal")}
    if "ix_file_sync_journal_dirty_revision" not in indexes:
        op.create_index(
            "ix_file_sync_journal_dirty_revision", "file_sync_journal",
            ["binding_id", "dirty_revision"],
        )


def _create_snapshot_tables() -> None:
    tables = _tables()
    if "file_sync_user_scan_states" not in tables:
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
        )

    if "file_sync_reconcile_runs" not in tables:
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
            sa.Column("priority_since", sa.DateTime(timezone=True), nullable=False),
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
        )
        op.create_index("ix_file_sync_reconcile_runs_user_id", "file_sync_reconcile_runs", ["user_id"])
        op.create_index("ix_file_sync_reconcile_runs_binding_id", "file_sync_reconcile_runs", ["binding_id"])
        op.create_index("ix_file_sync_reconcile_runs_status", "file_sync_reconcile_runs", ["status"])
        op.create_index(
            "ix_file_sync_reconcile_claim", "file_sync_reconcile_runs",
            ["status", "lease_until", "created_at"],
        )
        op.create_index(
            "uq_file_sync_reconcile_active_binding", "file_sync_reconcile_runs", ["binding_id"],
            unique=True,
            postgresql_where=sa.text("status IN ('queued', 'running', 'paused', 'cancelling')"),
            sqlite_where=sa.text("status IN ('queued', 'running', 'paused', 'cancelling')"),
        )


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
        op.execute("SET LOCAL statement_timeout = '30s'")

    tables = _tables()
    if "file_sync_reconcile_runs" in tables:
        run_columns = _columns("file_sync_reconcile_runs")
        if "action" in run_columns and "reason" not in run_columns:
            row_count = bind.scalar(sa.text("SELECT count(*) FROM file_sync_reconcile_runs"))
            if row_count:
                raise RuntimeError("新版文件对账任务表仍有记录；已停止迁移以避免丢失任务事实")
            op.drop_table("file_sync_reconcile_runs")
        elif "mode" not in run_columns or "reason" not in run_columns:
            raise RuntimeError("文件对账任务表结构不符合预期；已停止恢复迁移")

    _restore_binding_columns()
    _restore_journal_column()
    _create_snapshot_tables()


def downgrade() -> None:
    raise RuntimeError("快照恢复后的任务与基线事实不可自动降级")
