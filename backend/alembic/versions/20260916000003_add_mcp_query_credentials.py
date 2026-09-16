"""MCP Query 参数认证凭据。

Revision: 20260916000003
Revises: 20260916000002
"""
from alembic import op
import sqlalchemy as sa


revision = "20260916000003"
down_revision = "20260916000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_mcp_servers", sa.Column("auth_mode", sa.String(16), nullable=False, server_default="headers"))
    op.add_column("user_mcp_servers", sa.Column("encrypted_query_params", sa.Text(), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("query_params_nonce", sa.String(64), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("encrypted_query_params_key", sa.Text(), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("query_params_key_version", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    op.drop_column("user_mcp_servers", "query_params_key_version")
    op.drop_column("user_mcp_servers", "encrypted_query_params_key")
    op.drop_column("user_mcp_servers", "query_params_nonce")
    op.drop_column("user_mcp_servers", "encrypted_query_params")
    op.drop_column("user_mcp_servers", "auth_mode")
