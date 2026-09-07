"""补充本地目录绑定路径和同步冲突表。"""
from alembic import op
import sqlalchemy as sa

revision = "20260906000004"
down_revision = "20260906000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {item["name"] for item in inspector.get_columns("file_sync_bindings")}
    if "root_path" not in columns:
        op.add_column(
            "file_sync_bindings",
            sa.Column("root_path", sa.String(1000), nullable=False, server_default="."),
        )
    if "file_sync_conflicts" not in set(inspector.get_table_names()):
        op.create_table(
            "file_sync_conflicts",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("binding_id", sa.Integer(), sa.ForeignKey("file_sync_bindings.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("relative_path", sa.String(1000), nullable=False),
            sa.Column("baseline_fingerprint", sa.String(64), nullable=True),
            sa.Column("local_fingerprint", sa.String(64), nullable=True),
            sa.Column("remote_fingerprint", sa.String(64), nullable=True),
            sa.Column("status", sa.String(24), nullable=False, server_default="pending"),
            sa.Column("resolution", sa.String(24), nullable=True),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_file_sync_conflicts_binding_id", "file_sync_conflicts", ["binding_id"])
        op.create_index("ix_file_sync_conflicts_user_status", "file_sync_conflicts", ["user_id", "status"])
        op.create_index("ix_file_sync_conflicts_binding_path", "file_sync_conflicts", ["binding_id", "relative_path"])


def downgrade() -> None:
    op.drop_table("file_sync_conflicts")
    op.drop_column("file_sync_bindings", "root_path")
