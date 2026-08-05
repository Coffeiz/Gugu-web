"""为 QQ 群聊增加普通消息记录开关。"""

from alembic import op

revision = "20260803000001"
down_revision = "20260715000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS group_read_enabled BOOLEAN NOT NULL DEFAULT FALSE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS group_read_enabled")
