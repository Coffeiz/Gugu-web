"""将 QQ 群聊默认行为改为无需 @ 机器人。"""

from alembic import op


revision = "20260803000008"
down_revision = "20260803000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ALTER COLUMN group_requires_at SET DEFAULT FALSE"
    )
    op.execute("UPDATE user_bots SET group_requires_at = FALSE")


def downgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ALTER COLUMN group_requires_at SET DEFAULT TRUE"
    )
