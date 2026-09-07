"""允许复用已删除 Workspace 的目录名。"""

from alembic import op
import sqlalchemy as sa


revision = "20260907000005"
down_revision = "20260907000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("workspace_directories", recreate="always") as batch_op:
            batch_op.drop_constraint("uq_workspace_directory_name", type_="unique")
    else:
        op.drop_constraint("uq_workspace_directory_name", "workspace_directories", type_="unique")
    op.create_index(
        "uq_workspace_directory_name",
        "workspace_directories",
        ["user_id", "directory_name"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_workspace_directory_name", table_name="workspace_directories")
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("workspace_directories", recreate="always") as batch_op:
            batch_op.create_unique_constraint(
                "uq_workspace_directory_name", ["user_id", "directory_name"]
            )
    else:
        op.create_unique_constraint(
            "uq_workspace_directory_name",
            "workspace_directories",
            ["user_id", "directory_name"],
        )
