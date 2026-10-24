"""恢复独立的 QQ 私聊实时流式开关。"""
from alembic import op
import sqlalchemy as sa


revision = "20261024000001"
down_revision = "20261023000001"
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
    # 2026-10-14 起 Markdown 私聊即代表此前独立开关开启时的有效行为。
    # 迁移时保留该行为，用户之后可在设置中单独关闭。
    op.execute(
        sa.text(
            "UPDATE user_bots SET private_streaming_enabled = TRUE "
            "WHERE private_message_format = 'markdown'"
        )
    )


def downgrade() -> None:
    op.drop_column("user_bots", "private_streaming_enabled")
