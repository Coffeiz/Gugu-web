"""为定时任务增加工作区、相对 cwd 和任务级沙箱授权引用。"""
from alembic import op
import sqlalchemy as sa


revision = "20260905000007"
down_revision = "20260905000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("scheduled_tasks")}
    if "workspace_id" not in columns:
        op.add_column(
            "scheduled_tasks",
            sa.Column("workspace_id", sa.Integer(), nullable=True),
        )
        op.create_foreign_key(
            "fk_scheduled_tasks_workspace_id",
            "scheduled_tasks",
            "workspaces",
            ["workspace_id"],
            ["id"],
            ondelete="SET NULL",
        )
        op.create_index("ix_scheduled_tasks_workspace_id", "scheduled_tasks", ["workspace_id"])
    if "cwd" not in columns:
        op.add_column("scheduled_tasks", sa.Column("cwd", sa.String(length=1000), nullable=True))
    if "filesystem_authorization_grant_id" not in columns:
        op.add_column(
            "scheduled_tasks",
            sa.Column("filesystem_authorization_grant_id", sa.Integer(), nullable=True),
        )
        op.create_foreign_key(
            "fk_scheduled_tasks_filesystem_authorization_grant_id",
            "scheduled_tasks",
            "filesystem_authorization_grants",
            ["filesystem_authorization_grant_id"],
            ["id"],
            ondelete="SET NULL",
        )
        op.create_index(
            "ix_scheduled_tasks_filesystem_authorization_grant_id",
            "scheduled_tasks",
            ["filesystem_authorization_grant_id"],
        )


def downgrade() -> None:
    op.drop_index("ix_scheduled_tasks_filesystem_authorization_grant_id", table_name="scheduled_tasks")
    op.drop_constraint(
        "fk_scheduled_tasks_filesystem_authorization_grant_id",
        "scheduled_tasks",
        type_="foreignkey",
    )
    op.drop_column("scheduled_tasks", "filesystem_authorization_grant_id")
    op.drop_column("scheduled_tasks", "cwd")
    op.drop_index("ix_scheduled_tasks_workspace_id", table_name="scheduled_tasks")
    op.drop_constraint("fk_scheduled_tasks_workspace_id", "scheduled_tasks", type_="foreignkey")
    op.drop_column("scheduled_tasks", "workspace_id")
