"""扩展 IM 平台消息 ID 长度，兼容 QQ 长 msg_idx。"""
from alembic import op
import sqlalchemy as sa


revision = "20261029000006"
down_revision = "20261029000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "conversation_messages",
        "im_platform_message_id",
        existing_type=sa.String(length=128),
        type_=sa.String(length=512),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "conversation_messages",
        "im_platform_message_id",
        existing_type=sa.String(length=512),
        type_=sa.String(length=128),
        existing_nullable=True,
    )
