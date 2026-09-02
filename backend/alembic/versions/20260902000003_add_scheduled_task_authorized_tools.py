"""为定时任务保存用户明确授权的自动工具范围。"""
from alembic import op
import sqlalchemy as sa

revision = "20260902000003"
down_revision = "20260902000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "authorized_tools" not in columns:
        op.add_column(
            "scheduled_tasks",
            sa.Column("authorized_tools", sa.JSON(), nullable=False, server_default="[]"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "authorized_tools" in columns:
        op.drop_column("scheduled_tasks", "authorized_tools")
