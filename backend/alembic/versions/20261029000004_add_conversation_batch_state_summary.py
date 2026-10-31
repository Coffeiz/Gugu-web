"""为 canonical 批次添加无正文的执行状态摘要。"""
from alembic import op
import sqlalchemy as sa


revision = "20261029000004"
down_revision = "20261029000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_batches",
        sa.Column("state_summary", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation_batches", "state_summary")
