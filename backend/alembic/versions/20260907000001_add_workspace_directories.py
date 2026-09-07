"""增加文件库顶层 Workspace 元数据。"""

from alembic import op
import sqlalchemy as sa


revision = "20260907000001"
down_revision = "20260906000008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspace_directories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("directory_name", sa.String(length=200), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_system", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "directory_name", name="uq_workspace_directory_name"),
    )
    op.create_index("ix_workspace_directories_user_id", "workspace_directories", ["user_id"])
    op.create_index("ix_workspace_directories_deleted_at", "workspace_directories", ["deleted_at"])
    op.create_index(
        "uq_workspace_directory_default", "workspace_directories", ["user_id"], unique=True,
        postgresql_where=sa.text("is_default = true AND deleted_at IS NULL"),
    )
    op.execute(sa.text(
        "INSERT INTO workspace_directories "
        "(user_id, name, directory_name, is_default, is_system, created_at, updated_at) "
        "SELECT id, '默认工作区', 'workspace', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM users"
    ))


def downgrade() -> None:
    op.drop_index("uq_workspace_directory_default", table_name="workspace_directories")
    op.drop_index("ix_workspace_directories_deleted_at", table_name="workspace_directories")
    op.drop_index("ix_workspace_directories_user_id", table_name="workspace_directories")
    op.drop_table("workspace_directories")
