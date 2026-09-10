"""为定时任务增加邮件附件配置。"""
from alembic import op
import sqlalchemy as sa


revision = "20260908000002"
down_revision = "20260908000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("scheduled_tasks")}
    if "email_attachment_file_ids" not in columns:
        op.add_column(
            "scheduled_tasks",
            sa.Column("email_attachment_file_ids", sa.JSON(), nullable=False, server_default="[]"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("scheduled_tasks")}
    if "email_attachment_file_ids" in columns:
        op.drop_column("scheduled_tasks", "email_attachment_file_ids")
