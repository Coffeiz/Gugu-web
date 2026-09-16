"""user_mcp_servers：用户自带 MCP server 配置（PRD-MCP-1 FR-MCP-1/MCP1-003）。

user_id 可空为 scope=platform 预留位（NULL=平台级，本期不写入）；
headers 三件套信封加密，downgrade 删表回滚。

Revision: 20260916000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20260916000001"
down_revision = "20260914000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_mcp_servers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("scope", sa.String(16), nullable=False, server_default="user"),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("transport", sa.String(16), nullable=False, server_default="http"),
        sa.Column("endpoint", sa.String(1000), nullable=False),
        sa.Column("encrypted_headers", sa.Text(), nullable=False, server_default=""),
        sa.Column("headers_nonce", sa.String(64), nullable=False, server_default=""),
        sa.Column("encrypted_headers_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("headers_key_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("confirm_mode", sa.String(16), nullable=False, server_default="confirm_all"),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("tool_allowlist", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "scope", "name", name="uq_user_mcp_servers_scope_name"),
    )
    op.create_index("ix_user_mcp_servers_user_id", "user_mcp_servers", ["user_id"])


def downgrade() -> None:
    op.drop_table("user_mcp_servers")
