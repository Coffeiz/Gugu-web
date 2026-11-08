"""保存用户图片消息的模型输入快照。"""
from alembic import op
import sqlalchemy as sa


revision = "20261108000001"
down_revision = "20261101000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversation_messages", sa.Column("provider_image_content", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("conversation_messages", "provider_image_content")
