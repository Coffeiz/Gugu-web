"""新增独立的 Provider 推理状态表。"""
from alembic import op
import sqlalchemy as sa


revision = "llm23_phase1"
down_revision = "20260905000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "provider_reasoning_states",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("state_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("status", sa.String(length=20), server_default="active", nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("api_format", sa.String(length=32), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("reasoning_persistence", sa.String(length=20), nullable=False),
        sa.Column("config_digest", sa.String(length=64), nullable=False),
        sa.Column("reasoning_config_digest", sa.String(length=64), nullable=False),
        sa.Column("source_run_id", sa.String(length=128), nullable=False),
        sa.Column("source_round_id", sa.String(length=128), nullable=True),
        sa.Column("sequence", sa.Integer(), server_default="0", nullable=False),
        sa.Column("state_kind", sa.String(length=80), nullable=False),
        sa.Column("encrypted_payload", sa.Text(), nullable=False, server_default=""),
        sa.Column("payload_nonce", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("encrypted_data_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("key_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("payload_digest", sa.String(length=64), nullable=False),
        sa.Column("payload_size", sa.Integer(), server_default="0", nullable=False),
        sa.Column("state_summary", sa.JSON(), nullable=True),
        sa.Column("invalidated_reason", sa.String(length=80), nullable=True),
        sa.Column("invalidated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id", name="uq_provider_reasoning_states_session"),
    )
    op.create_index("ix_provider_reasoning_states_user_id", "provider_reasoning_states", ["user_id"])
    op.create_index("ix_provider_reasoning_states_status", "provider_reasoning_states", ["status"])
    op.create_index("ix_provider_reasoning_states_expires_at", "provider_reasoning_states", ["expires_at"])
    op.create_index(
        "ix_provider_reasoning_states_session_status",
        "provider_reasoning_states",
        ["session_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_provider_reasoning_states_session_status", table_name="provider_reasoning_states")
    op.drop_index("ix_provider_reasoning_states_expires_at", table_name="provider_reasoning_states")
    op.drop_index("ix_provider_reasoning_states_status", table_name="provider_reasoning_states")
    op.drop_index("ix_provider_reasoning_states_user_id", table_name="provider_reasoning_states")
    op.drop_table("provider_reasoning_states")
