"""恢复 QQ C2C 私聊流式回复开关。"""

from alembic import op
import sqlalchemy as sa


revision = "20260831000003"
down_revision = "20260831000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_bots",
        sa.Column(
            "private_streaming_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("user_bots", "private_streaming_enabled")
