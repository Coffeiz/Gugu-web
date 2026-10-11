"""前向清理已撤回的文件同步快照重构结构，保留原同步事实。"""

from alembic import op
import sqlalchemy as sa


revision = "20261007000001"
down_revision = "20261006000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "file_sync_reconcile_runs" in tables:
        active = bind.scalar(sa.text(
            "SELECT count(*) FROM file_sync_reconcile_runs "
            "WHERE status IN ('queued', 'running', 'paused', 'cancelling')"
        ))
        if active:
            raise RuntimeError("仍有快照重构任务未结束；请停用旧执行器并备份后再清理")

    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
        op.execute("SET LOCAL statement_timeout = '30s'")

    # 不使用 CASCADE，意外存在外部依赖时拒绝清理，而不是扩大删除范围。
    for table in ("file_sync_reconcile_runs", "file_sync_user_scan_states"):
        if table in tables:
            op.drop_table(table)

    columns = {
        "file_sync_bindings": (
            "scope_revision", "dirty_revision", "baseline_dirty_revision",
            "baseline_generation", "last_daily_reconciled_at",
            "last_integrity_verified_at", "next_reconcile_at", "consecutive_failures",
        ),
        "file_sync_journal": ("dirty_revision",),
    }
    for table, retired in columns.items():
        if table not in tables:
            continue
        inspector = sa.inspect(bind)
        present = {column["name"] for column in inspector.get_columns(table)}
        indexes = inspector.get_indexes(table)
        for index in indexes:
            if set(index["column_names"]) & set(retired):
                op.drop_index(index["name"], table_name=table)
        for column in retired:
            if column in present:
                op.drop_column(table, column)


def downgrade() -> None:
    raise RuntimeError("清理前的快照任务事实只能从备份恢复，不支持伪造空表降级")
