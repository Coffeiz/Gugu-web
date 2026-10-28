"""为用户 MCP 工具声明持久化快照。"""
from alembic import op
import sqlalchemy as sa


revision = "20261028000002"
down_revision = "20261028000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_mcp_tool_schema_snapshots",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("config_digest", sa.String(length=64), nullable=False),
        sa.Column("schemas", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("refreshed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("user_mcp_tool_schema_snapshots")
