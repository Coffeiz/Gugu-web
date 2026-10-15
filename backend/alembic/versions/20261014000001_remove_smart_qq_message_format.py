"""将历史 QQ 智能消息格式选项统一为 Markdown。"""
from alembic import op
import sqlalchemy as sa


revision = "20261014000001"
down_revision = "20261013000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE user_bots SET group_message_format = 'markdown' "
        "WHERE group_message_format = 'smart'"
    )
    op.execute(
        "UPDATE user_bots SET private_message_format = 'markdown' "
        "WHERE private_message_format = 'smart'"
    )
    with op.batch_alter_table("user_bots") as batch:
        batch.alter_column(
            "private_message_format",
            existing_type=sa.String(length=16),
            existing_nullable=False,
            existing_server_default="smart",
            server_default="markdown",
        )


def downgrade() -> None:
    # 数据归一化不可无损逆转；保留已迁移值，只恢复旧版数据库默认值。
    with op.batch_alter_table("user_bots") as batch:
        batch.alter_column(
            "private_message_format",
            existing_type=sa.String(length=16),
            existing_nullable=False,
            existing_server_default="markdown",
            server_default="smart",
        )
