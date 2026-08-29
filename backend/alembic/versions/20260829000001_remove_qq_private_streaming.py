"""移除未使用的 QQ C2C 私聊流式配置。"""

from alembic import op
import sqlalchemy as sa


revision = "20260829000001"
down_revision = "20260828000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("user_bots", "private_streaming_enabled")


def downgrade() -> None:
    op.add_column(
        "user_bots",
        sa.Column(
            "private_streaming_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
