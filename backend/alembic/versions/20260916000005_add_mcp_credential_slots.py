"""统一 MCP 凭据槽位和加密值。"""
from alembic import op
import sqlalchemy as sa


revision = "20260916000005"
down_revision = "20260916000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_mcp_servers", sa.Column("credential_slots", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column("user_mcp_servers", sa.Column("encrypted_credentials", sa.Text(), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("credentials_nonce", sa.String(64), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("encrypted_credentials_key", sa.Text(), nullable=False, server_default=""))
    op.add_column("user_mcp_servers", sa.Column("credentials_key_version", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    op.drop_column("user_mcp_servers", "credentials_key_version")
    op.drop_column("user_mcp_servers", "encrypted_credentials_key")
    op.drop_column("user_mcp_servers", "credentials_nonce")
    op.drop_column("user_mcp_servers", "encrypted_credentials")
    op.drop_column("user_mcp_servers", "credential_slots")
