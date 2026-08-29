"""增加会话级 Shell 执行范围。"""

from alembic import op


revision = "20260824000001"
down_revision = "20260823000008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS shell_scope VARCHAR(20) NOT NULL DEFAULT 'off'")
    op.execute("UPDATE conversation_sessions SET shell_scope = 'workspace' WHERE workspace_id IS NOT NULL AND shell_scope = 'off'")


def downgrade() -> None:
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS shell_scope")
