"""记录对账任务启动时已知的监听缺口水位。"""

from alembic import op
import sqlalchemy as sa


revision = "20261007000005"
down_revision = "20261007000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "file_sync_reconcile_runs",
        sa.Column("gap_revision_at_start", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("file_sync_reconcile_runs", "gap_revision_at_start")
