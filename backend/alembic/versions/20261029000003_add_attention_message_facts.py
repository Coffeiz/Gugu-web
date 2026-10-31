"""为 IM 历史消息保存注意力门控所需的平台结构化事实。"""
from alembic import op
import sqlalchemy as sa


revision = "20261029000003"
down_revision = "20261029000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversation_messages", sa.Column("im_platform_message_id", sa.String(128), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_reply_to_message_id", sa.String(128), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_reply_target_sender_id", sa.String(128), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_reply_target_is_bot", sa.Boolean(), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_sender_is_bot", sa.Boolean(), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_event_received_ms", sa.BigInteger(), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_platform_sent_ms", sa.BigInteger(), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_media_kinds", sa.JSON(), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_media_processable", sa.Boolean(), nullable=True))
    op.add_column("conversation_messages", sa.Column("im_mention_facts", sa.JSON(), nullable=True))
    op.create_index(
        "ix_conversation_messages_im_platform_message_id",
        "conversation_messages",
        ["im_platform_message_id"],
    )
    op.create_index(
        "ix_conversation_messages_im_event_received_ms",
        "conversation_messages",
        ["im_event_received_ms"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_messages_im_event_received_ms", table_name="conversation_messages")
    op.drop_index("ix_conversation_messages_im_platform_message_id", table_name="conversation_messages")
    for name in (
        "im_mention_facts", "im_media_processable", "im_media_kinds", "im_platform_sent_ms",
        "im_event_received_ms", "im_sender_is_bot", "im_reply_target_is_bot",
        "im_reply_target_sender_id", "im_reply_to_message_id", "im_platform_message_id",
    ):
        op.drop_column("conversation_messages", name)
