"""约束活动文件记录的用户存储路径唯一，保留软删除历史。"""

from alembic import op
from sqlalchemy import text


revision = "20261009000001"
down_revision = "20261008000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    duplicate_keys = op.get_bind().scalar(text(
        "SELECT COUNT(*) FROM ("
        "SELECT 1 FROM files WHERE deleted_at IS NULL "
        "GROUP BY user_id, storage_key HAVING COUNT(*) > 1"
        ") AS duplicate_active_paths"
    ))
    if duplicate_keys:
        raise RuntimeError(
            "文件同步迁移已停止：发现重复的活动文件存储路径。"
            "请先通过存储对账逐项处理重复记录后重试；未修改或删除任何文件记录。"
        )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_files_active_user_storage_key "
        "ON files (user_id, storage_key) WHERE deleted_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_files_active_user_storage_key")
