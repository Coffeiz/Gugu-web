"""为 IM Bot 增加群组与群成员记忆开关。"""

from alembic import op


revision = "20260823000008"
down_revision = "20260823000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS group_memory_enabled "
        "BOOLEAN NOT NULL DEFAULT TRUE"
    )
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS member_memory_enabled "
        "BOOLEAN NOT NULL DEFAULT TRUE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS member_memory_enabled")
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS group_memory_enabled")
