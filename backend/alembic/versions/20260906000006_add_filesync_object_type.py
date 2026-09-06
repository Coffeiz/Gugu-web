"""为文件同步 journal 增加文件夹对象类型。"""
from alembic import op
import sqlalchemy as sa


revision = "20260906000006"
down_revision = "20260906000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in sa.inspect(bind).get_columns("file_sync_journal")}
    if "object_type" not in columns:
        op.add_column(
            "file_sync_journal",
            sa.Column("object_type", sa.String(16), nullable=False, server_default="file"),
        )


def downgrade() -> None:
    op.drop_column("file_sync_journal", "object_type")
