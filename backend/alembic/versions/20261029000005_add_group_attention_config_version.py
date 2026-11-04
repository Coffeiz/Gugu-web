"""为群聊注意力模式配置增加版本号，供运行审计使用。"""
from alembic import op
import sqlalchemy as sa


revision = "20261029000005"
down_revision = "20261029000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_bots",
        sa.Column(
            "group_attention_config_version",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("user_bots", "group_attention_config_version")
