"""记录会话历史最近使用的 provider/API 格式。"""

from alembic import op
import sqlalchemy as sa


revision = "20260824000002"
down_revision = "20260824000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_sessions",
        sa.Column("history_provider", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "conversation_sessions",
        sa.Column("history_api_format", sa.String(length=20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation_sessions", "history_api_format")
    op.drop_column("conversation_sessions", "history_provider")
