"""将历史 Shell 文件同步绑定收口为本地目录绑定。"""
from alembic import op
import sqlalchemy as sa


revision = "20260906000007"
down_revision = "20260906000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "file_sync_bindings" not in tables:
        return
    # 同一用户/工作区已有统一本地绑定时，保留它并停用旧 Shell 行，避免唯一键冲突。
    bind.execute(sa.text("""
        UPDATE file_sync_bindings
        SET status = 'disabled'
        WHERE source = 'shell'
          AND EXISTS (
              SELECT 1 FROM file_sync_bindings local_binding
              WHERE local_binding.user_id = file_sync_bindings.user_id
                AND (
                    local_binding.workspace_id = file_sync_bindings.workspace_id
                    OR (local_binding.workspace_id IS NULL AND file_sync_bindings.workspace_id IS NULL)
                )
                AND local_binding.source = 'local_directory'
          )
    """))
    bind.execute(sa.text("""
        UPDATE file_sync_bindings
        SET source = 'local_directory'
        WHERE source = 'shell' AND status = 'active'
    """))


def downgrade() -> None:
    # 迁移只合并历史来源，无法安全区分合并前的绑定，回滚不拆分数据。
    pass
