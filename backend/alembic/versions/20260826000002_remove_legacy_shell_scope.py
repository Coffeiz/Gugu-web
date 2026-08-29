"""删除已不再参与权限判定的会话 shell_scope 字段。"""
from alembic import op

revision = "20260826000002"
down_revision = "20260826000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS shell_scope")


def downgrade() -> None:
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS shell_scope VARCHAR(20) NOT NULL DEFAULT 'off'")
