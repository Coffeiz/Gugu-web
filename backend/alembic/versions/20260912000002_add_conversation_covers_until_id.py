"""summary 行补 covers_until_id 压缩水位列。"""

from alembic import op
import sqlalchemy as sa


revision = "20260912000002"
down_revision = "20260912000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_messages",
        sa.Column("covers_until_id", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation_messages", "covers_until_id")
