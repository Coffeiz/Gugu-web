"""加密保存 MCP HTTP endpoint。

Revision: 20260916000004
Revises: 20260916000003
"""
from alembic import op
import sqlalchemy as sa


revision = "20260916000004"
down_revision = "20260916000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_mcp_servers", sa.Column("encrypted_endpoint", sa.Text(), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("endpoint_nonce", sa.String(64), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("encrypted_endpoint_key", sa.Text(), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("endpoint_key_version", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    op.drop_column("user_mcp_servers", "endpoint_key_version")
    op.drop_column("user_mcp_servers", "encrypted_endpoint_key")
    op.drop_column("user_mcp_servers", "endpoint_nonce")
    op.drop_column("user_mcp_servers", "encrypted_endpoint")
