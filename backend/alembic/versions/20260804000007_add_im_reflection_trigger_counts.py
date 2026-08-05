"""为 IM 记忆游标增加被动消息/Agent 回合触发计数。"""

from alembic import op


revision = "20260804000007"
down_revision = "20260804000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE memory_reflection_cursors "
        "ADD COLUMN IF NOT EXISTS pending_passive_count INTEGER NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE memory_reflection_cursors "
        "ADD COLUMN IF NOT EXISTS pending_agent_count INTEGER NOT NULL DEFAULT 0"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE memory_reflection_cursors DROP COLUMN IF EXISTS pending_agent_count")
    op.execute("ALTER TABLE memory_reflection_cursors DROP COLUMN IF EXISTS pending_passive_count")
