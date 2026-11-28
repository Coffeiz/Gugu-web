"""保存交互消费后的待恢复引用；不保存回答或凭据正文。"""
from alembic import op
import sqlalchemy as sa

revision = "20261115000006"
down_revision = "20261115000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_interaction_intents",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("interaction_id", sa.String(length=200), nullable=False),
        sa.Column("tool_call_id", sa.String(length=200), nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("encrypted_data_key", sa.Text(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "session_id", "run_id", "interaction_id"),
        sa.ForeignKeyConstraint(["user_id", "session_id", "run_id"], ["agent_run_checkpoints.user_id", "agent_run_checkpoints.session_id", "agent_run_checkpoints.run_id"], ondelete="CASCADE"),
    )
    op.create_table(
        "agent_interaction_bindings",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("prompt_id", sa.Integer(), primary_key=True),
        sa.Column("interaction_id", sa.String(length=200), nullable=False),
        sa.Column("tool_call_id", sa.String(length=200), nullable=False),
        sa.UniqueConstraint("user_id", "session_id", "run_id", "interaction_id"),
        sa.ForeignKeyConstraint(["prompt_id"], ["interaction_prompts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id", "session_id", "run_id"], ["agent_run_checkpoints.user_id", "agent_run_checkpoints.session_id", "agent_run_checkpoints.run_id"], ondelete="CASCADE"),
    )
    op.create_table(
        "agent_interaction_resumes",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("prompt_id", sa.Integer(), nullable=False),
        sa.Column("interaction_id", sa.String(length=200), nullable=False),
        sa.Column("receipt", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claim_token", sa.String(length=64), nullable=True),
        sa.Column("claim_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("user_id", "session_id", "run_id", "prompt_id"),
        sa.UniqueConstraint("user_id", "session_id", "run_id", "receipt"),
        sa.ForeignKeyConstraint(["prompt_id"], ["interaction_prompts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id", "session_id", "run_id"], ["agent_run_checkpoints.user_id", "agent_run_checkpoints.session_id", "agent_run_checkpoints.run_id"], ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("agent_interaction_resumes")
    op.drop_table("agent_interaction_bindings")
    op.drop_table("agent_interaction_intents")
