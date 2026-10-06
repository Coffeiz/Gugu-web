"""持久化监听健康与待手动核对状态。"""

from alembic import op
import sqlalchemy as sa


revision = "20261007000002"
down_revision = "20261007000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file_sync_bindings", sa.Column(
        "watcher_status", sa.String(24), nullable=False, server_default="unknown",
    ))
    op.add_column("file_sync_bindings", sa.Column(
        "needs_reconcile", sa.Boolean(), nullable=False, server_default=sa.true(),
    ))
    op.add_column("file_sync_bindings", sa.Column(
        "health_revision", sa.Integer(), nullable=False, server_default="0",
    ))
    op.add_column("file_sync_bindings", sa.Column(
        "gap_revision", sa.Integer(), nullable=False, server_default="0",
    ))
    op.add_column("file_sync_bindings", sa.Column(
        "health_error_code", sa.String(64), nullable=True,
    ))


def downgrade() -> None:
    for name in (
        "health_error_code", "gap_revision", "health_revision", "needs_reconcile", "watcher_status",
    ):
        op.drop_column("file_sync_bindings", name)
