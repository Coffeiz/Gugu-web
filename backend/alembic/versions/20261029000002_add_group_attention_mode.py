"""为 UserBot 添加群聊注意力参与度设置。"""
from alembic import op
import sqlalchemy as sa


revision = "20261029000002"
down_revision = "20261029000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_bots",
        sa.Column(
            "group_attention_mode",
            sa.String(length=16),
            nullable=False,
            server_default="autonomous",
        ),
    )


def downgrade() -> None:
    op.drop_column("user_bots", "group_attention_mode")
