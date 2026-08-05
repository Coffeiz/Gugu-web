"""保存 IM 消息的发言人和会话类型。"""

from alembic import op
import sqlalchemy as sa


revision = "20260803000005"
down_revision = "20260803000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversation_messages", sa.Column("platform_user_id", sa.String(length=128), nullable=True))
    op.add_column("conversation_messages", sa.Column("chat_type", sa.String(length=20), nullable=True))
    op.create_index(
        "ix_conversation_messages_platform_user_id",
        "conversation_messages",
        ["platform_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_messages_platform_user_id", table_name="conversation_messages")
    op.drop_column("conversation_messages", "chat_type")
    op.drop_column("conversation_messages", "platform_user_id")
