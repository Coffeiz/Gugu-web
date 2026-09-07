"""移除定时任务的独立 cwd，绑定 workspace 后统一从根目录执行。"""
from alembic import op
import sqlalchemy as sa


revision = "20260906000001"
down_revision = "20260905000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "cwd" in columns:
        with op.batch_alter_table("scheduled_tasks") as batch_op:
            batch_op.drop_column("cwd")


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "cwd" not in columns:
        with op.batch_alter_table("scheduled_tasks") as batch_op:
            batch_op.add_column(sa.Column("cwd", sa.String(length=1000), nullable=True))
