"""将 QQ C2C 私聊流式回复默认改为关闭。"""

from alembic import op


revision = "20260822000005"
down_revision = "20260822000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ALTER COLUMN private_streaming_enabled "
        "SET DEFAULT FALSE"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ALTER COLUMN private_streaming_enabled "
        "SET DEFAULT TRUE"
    )
