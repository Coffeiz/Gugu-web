"""增加 Web 统一撤销操作记录。"""
from alembic import op
import sqlalchemy as sa


revision = "20260909000001"
down_revision = "20260908000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "undo_operations",
        sa.Column("id", sa.String(length=80), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("undo_context_id", sa.String(length=128), nullable=False),
        sa.Column("group_id", sa.String(length=80), nullable=False),
        sa.Column("resource", sa.String(length=32), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("target_refs", sa.JSON(), nullable=False),
        sa.Column("before_state", sa.JSON(), nullable=False),
        sa.Column("after_state", sa.JSON(), nullable=False),
        sa.Column("base_versions", sa.JSON(), nullable=False),
        sa.Column("artifact_refs", sa.JSON(), nullable=False),
        sa.Column("actor_type", sa.String(length=32), server_default="web", nullable=False),
        sa.Column("status", sa.String(length=24), server_default="active", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=80), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_undo_operations_user_id", "undo_operations", ["user_id"])
    op.create_index("ix_undo_operations_undo_context_id", "undo_operations", ["undo_context_id"])
    op.create_index("ix_undo_operations_group_id", "undo_operations", ["group_id"])
    op.create_index("ix_undo_operations_actor_type", "undo_operations", ["actor_type"])
    op.create_index("ix_undo_operations_status", "undo_operations", ["status"])
    op.create_index("ix_undo_operations_created_at", "undo_operations", ["created_at"])
    op.create_index("ix_undo_operations_expires_at", "undo_operations", ["expires_at"])
    op.create_index(
        "ix_undo_operations_context_status_created",
        "undo_operations",
        ["user_id", "undo_context_id", "status", "created_at"],
    )
    op.create_index("ix_undo_operations_group", "undo_operations", ["user_id", "group_id"])


def downgrade() -> None:
    op.drop_index("ix_undo_operations_group", table_name="undo_operations")
    op.drop_index("ix_undo_operations_context_status_created", table_name="undo_operations")
    op.drop_index("ix_undo_operations_expires_at", table_name="undo_operations")
    op.drop_index("ix_undo_operations_created_at", table_name="undo_operations")
    op.drop_index("ix_undo_operations_status", table_name="undo_operations")
    op.drop_index("ix_undo_operations_actor_type", table_name="undo_operations")
    op.drop_index("ix_undo_operations_group_id", table_name="undo_operations")
    op.drop_index("ix_undo_operations_undo_context_id", table_name="undo_operations")
    op.drop_index("ix_undo_operations_user_id", table_name="undo_operations")
    op.drop_table("undo_operations")
