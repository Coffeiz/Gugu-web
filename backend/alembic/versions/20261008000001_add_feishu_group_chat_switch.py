"""为飞书机器人单独保存群聊启用状态。"""

from alembic import op
import sqlalchemy as sa


revision = "20261008000001"
down_revision = "20261007000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_bots",
        sa.Column("feishu_group_chat_enabled", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_bots", "feishu_group_chat_enabled")
