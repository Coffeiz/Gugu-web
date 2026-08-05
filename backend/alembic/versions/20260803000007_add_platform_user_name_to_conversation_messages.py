"""保存 IM 发言人的平台显示名，用于自然称呼。"""

from alembic import op


revision = "20260803000007"
down_revision = "20260803000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_messages "
        "ADD COLUMN IF NOT EXISTS platform_user_name VARCHAR(255)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_messages "
        "DROP COLUMN IF EXISTS platform_user_name"
    )
