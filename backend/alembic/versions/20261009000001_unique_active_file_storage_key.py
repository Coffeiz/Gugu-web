"""约束活动文件记录的用户存储路径唯一，保留软删除历史。"""

from alembic import op


revision = "20261009000001"
down_revision = "20261008000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_files_active_user_storage_key "
        "ON files (user_id, storage_key) WHERE deleted_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_files_active_user_storage_key")
