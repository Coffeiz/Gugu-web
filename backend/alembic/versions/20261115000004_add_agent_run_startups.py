"""保存 Agent 运行启动登记及失败状态。"""
from alembic import op
import sqlalchemy as sa

revision = "20261115000004"
down_revision = "20261115000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_run_startups",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "session_id", "run_id"),
        sa.CheckConstraint("status IN ('pending', 'failed')", name="ck_agent_run_startup_status"),
    )
    op.create_table(
        "agent_run_dispatch",
        sa.Column("sequence", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), sa.Identity(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=128), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("request_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=True),
        sa.Column("fence", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("blocked_reason", sa.String(length=32), nullable=True),
        sa.UniqueConstraint("user_id", "session_id", "run_id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["conversation_messages.id"], ondelete="CASCADE"),
        sa.CheckConstraint("state IN ('queued', 'selected', 'done')", name="ck_agent_run_dispatch_state"),
    )
    op.create_index("uq_agent_dispatch_selected", "agent_run_dispatch", ["user_id", "session_id"], unique=True, postgresql_where=sa.text("state = 'selected'"), sqlite_where=sa.text("state = 'selected'"))


def downgrade() -> None:
    op.drop_index("uq_agent_dispatch_selected", table_name="agent_run_dispatch")
    op.drop_table("agent_run_dispatch")
    op.drop_table("agent_run_startups")
