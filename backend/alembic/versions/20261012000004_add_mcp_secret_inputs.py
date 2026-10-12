"""为 IM MCP 凭据输入增加短时密文状态。"""
from alembic import op
import sqlalchemy as sa


revision = "20261012000004"
down_revision = "20261012000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mcp_secret_inputs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("prompt_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("server_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("platform", sa.String(length=20), nullable=False),
        sa.Column("bot_id", sa.String(length=128), nullable=False),
        sa.Column("chat_id", sa.String(length=128), nullable=True),
        sa.Column("chat_type", sa.String(length=20), nullable=False),
        sa.Column("platform_user_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending_choice"),
        sa.Column("next_field_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("consumed_event_ids", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("encrypted_payload", sa.Text(), nullable=False, server_default=""),
        sa.Column("payload_nonce", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("encrypted_data_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("key_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["prompt_id"], ["interaction_prompts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["server_id"], ["user_mcp_servers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("prompt_id", name="uq_mcp_secret_inputs_prompt"),
    )
    op.create_index("ix_mcp_secret_inputs_user_id", "mcp_secret_inputs", ["user_id"])
    op.create_index("ix_mcp_secret_inputs_server_id", "mcp_secret_inputs", ["server_id"])
    op.create_index("ix_mcp_secret_inputs_session_id", "mcp_secret_inputs", ["session_id"])
    op.create_index("ix_mcp_secret_inputs_expires_at", "mcp_secret_inputs", ["expires_at"])
    op.create_index(
        "ix_mcp_secret_inputs_expiry_status", "mcp_secret_inputs", ["expires_at", "status"],
    )
    op.create_index(
        "ix_mcp_secret_inputs_im_scope", "mcp_secret_inputs",
        ["platform", "bot_id", "chat_type", "chat_id", "platform_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_mcp_secret_inputs_im_scope", table_name="mcp_secret_inputs")
    op.drop_index("ix_mcp_secret_inputs_expiry_status", table_name="mcp_secret_inputs")
    op.drop_index("ix_mcp_secret_inputs_expires_at", table_name="mcp_secret_inputs")
    op.drop_index("ix_mcp_secret_inputs_session_id", table_name="mcp_secret_inputs")
    op.drop_index("ix_mcp_secret_inputs_server_id", table_name="mcp_secret_inputs")
    op.drop_index("ix_mcp_secret_inputs_user_id", table_name="mcp_secret_inputs")
    op.drop_table("mcp_secret_inputs")
