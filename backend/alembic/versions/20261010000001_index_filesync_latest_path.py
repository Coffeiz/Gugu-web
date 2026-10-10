"""为按绑定和路径读取最新同步 Journal 增加有序索引。"""

from alembic import op
import sqlalchemy as sa


revision = "20261010000001"
down_revision = "20261009000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("file_sync_journal")
    }
    if "ix_file_sync_journal_latest_path" not in indexes:
        op.create_index(
            "ix_file_sync_journal_latest_path",
            "file_sync_journal",
            ["binding_id", "status", "object_type", "relative_path", "id"],
        )


def downgrade() -> None:
    op.drop_index(
        "ix_file_sync_journal_latest_path",
        table_name="file_sync_journal",
        if_exists=True,
    )
