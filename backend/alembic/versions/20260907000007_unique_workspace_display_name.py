"""为 Workspace 显示名补部分唯一索引。

directory_name 改为按 id 生成（workspace-<id>）后不再承担显示名唯一性，
并发创建同名 Workspace 需要 (user_id, name) 部分唯一索引兜底。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260907000007"
down_revision = "20260907000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_workspace_directory_display_name",
        "workspace_directories", ["user_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_workspace_directory_display_name", table_name="workspace_directories")
