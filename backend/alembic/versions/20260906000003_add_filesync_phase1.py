"""增加文件同步 Phase 1 协议表。"""
from alembic import op
import sqlalchemy as sa

revision = "20260906000003"
down_revision = "20260906000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "file_sync_bindings" not in tables:
        op.create_table(
            "file_sync_bindings",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("workspace_id", sa.Integer(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True),
            sa.Column("source", sa.String(24), nullable=False),
            sa.Column("mode", sa.String(24), nullable=False, server_default="bidirectional"),
            sa.Column("protocol_version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("status", sa.String(24), nullable=False, server_default="active"),
            sa.Column("root_fingerprint", sa.String(64), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_reconciled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("user_id", "workspace_id", "source", name="uq_file_sync_binding_scope"),
        )
        op.create_index("ix_file_sync_bindings_user_id", "file_sync_bindings", ["user_id"])
        op.create_index("ix_file_sync_bindings_user_status", "file_sync_bindings", ["user_id", "status"])
    if "file_sync_journal" not in tables:
        op.create_table(
            "file_sync_journal",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("binding_id", sa.Integer(), sa.ForeignKey("file_sync_bindings.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("idempotency_key", sa.String(128), nullable=False),
            sa.Column("source", sa.String(24), nullable=False),
            sa.Column("operation", sa.String(24), nullable=False),
            sa.Column("relative_path", sa.String(1000), nullable=False),
            sa.Column("baseline_fingerprint", sa.String(64), nullable=True),
            sa.Column("observed_fingerprint", sa.String(64), nullable=True),
            sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(24), nullable=False, server_default="pending"),
            sa.Column("error_code", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("binding_id", "idempotency_key", name="uq_file_sync_journal_idempotency"),
        )
        op.create_index("ix_file_sync_journal_binding_id", "file_sync_journal", ["binding_id"])
        op.create_index("ix_file_sync_journal_binding_revision", "file_sync_journal", ["binding_id", "revision"])
        op.create_index("ix_file_sync_journal_user_status", "file_sync_journal", ["user_id", "status"])


def downgrade() -> None:
    op.drop_table("file_sync_journal")
    op.drop_table("file_sync_bindings")
