"""为定时任务增加精确脚本授权。"""
from alembic import op
import sqlalchemy as sa


revision = "20260906000002"
down_revision = "20260906000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "script_authorization" not in columns:
        op.add_column("scheduled_tasks", sa.Column("script_authorization", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "script_authorization" in columns:
        op.drop_column("scheduled_tasks", "script_authorization")
