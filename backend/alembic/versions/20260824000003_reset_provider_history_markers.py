"""重置早期临时清理实现写入的历史协议标记。"""

from alembic import op


revision = "20260824000003"
down_revision = "20260824000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 早期版本只在发送边界临时过滤 thinking，却已经写入了当前协议标记；
    # 清空标记让新实现对这些旧 session 做一次持久化清理。
    op.execute(
        "UPDATE conversation_sessions "
        "SET history_provider = NULL, history_api_format = NULL "
        "WHERE history_provider IS NOT NULL OR history_api_format IS NOT NULL"
    )


def downgrade() -> None:
    pass
