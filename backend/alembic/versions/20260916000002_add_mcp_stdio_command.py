"""MCP stdio server 命令配置。

Revision: 20260916000002
Revises: 20260916000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20260916000002"
down_revision = "20260916000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_mcp_servers", sa.Column("command", sa.String(1000), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("user_mcp_servers", "command")
