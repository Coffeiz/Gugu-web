"""为 QQ 群聊和私聊增加文本消息格式策略。"""

from alembic import op

revision = "20260812000001"
down_revision = "20260809000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS group_message_format VARCHAR(16) NOT NULL DEFAULT 'compat'")
    op.execute("ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS private_message_format VARCHAR(16) NOT NULL DEFAULT 'smart'")


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS private_message_format")
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS group_message_format")
