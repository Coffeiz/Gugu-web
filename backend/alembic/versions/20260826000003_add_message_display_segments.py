"""保存助手多轮展示时间线，避免刷新后把 SSE 气泡重新合并。"""

from alembic import op

revision = "20260826000003"
down_revision = "20260826000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_messages "
        "ADD COLUMN IF NOT EXISTS display_timeline JSON"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_messages DROP COLUMN IF EXISTS display_timeline"
    )
