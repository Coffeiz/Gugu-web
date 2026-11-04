"""为会话消息增加客户端稳定身份。

Revision ID: 20261028000001
Revises: 20261024000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20261028000001"
down_revision = "20261024000001"
branch_labels = None
depends_on = None
bootstrap_on_legacy_database = True


def upgrade() -> None:
    op.add_column(
        "conversation_messages",
        sa.Column("client_message_id", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "uq_conversation_messages_session_client_message_id",
        "conversation_messages",
        ["session_id", "client_message_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "uq_conversation_messages_session_client_message_id",
        table_name="conversation_messages",
    )
    op.drop_column("conversation_messages", "client_message_id")
