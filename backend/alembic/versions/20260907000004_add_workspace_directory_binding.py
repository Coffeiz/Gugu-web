"""为工作区绑定声明增加顶层 Workspace 目录引用。"""
from alembic import op
import sqlalchemy as sa

revision = "20260907000004"
down_revision = "20260907000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("directory_id", sa.Integer(), nullable=True))
    op.create_index("ix_workspaces_directory_id", "workspaces", ["directory_id"])
    op.create_foreign_key(
        "fk_workspaces_directory_id",
        "workspaces", "workspace_directories", ["directory_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_workspaces_directory_id", "workspaces", type_="foreignkey")
    op.drop_index("ix_workspaces_directory_id", table_name="workspaces")
    op.drop_column("workspaces", "directory_id")
