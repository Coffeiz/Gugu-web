"""增加文件同步 canonical 事件可靠投递队列。"""
from alembic import op
import sqlalchemy as sa

revision = "20260906000005"
down_revision = "20260906000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "file_sync_outbox" in set(inspector.get_table_names()):
        columns = {item["name"] for item in inspector.get_columns("file_sync_conflicts")}
        if "source" not in columns:
            op.add_column("file_sync_conflicts", sa.Column("source", sa.String(24), nullable=True))
        return
    conflict_columns = {item["name"] for item in inspector.get_columns("file_sync_conflicts")}
    if "source" not in conflict_columns:
        op.add_column("file_sync_conflicts", sa.Column("source", sa.String(24), nullable=True))
    op.create_table(
        "file_sync_outbox",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_id", sa.String(80), nullable=False),
        sa.Column("resource", sa.String(64), nullable=False, server_default="files"),
        sa.Column("operation", sa.String(24), nullable=False, server_default="refresh"),
        sa.Column("entity_ids", sa.JSON(), nullable=True),
        sa.Column("source", sa.String(24), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.String(120), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("event_id", name="uq_file_sync_outbox_event_id"),
    )
    op.create_index("ix_file_sync_outbox_user_id", "file_sync_outbox", ["user_id"])
    op.create_index("ix_file_sync_outbox_pending", "file_sync_outbox", ["status", "next_attempt_at"])
    op.create_index("ix_file_sync_outbox_user_created", "file_sync_outbox", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_table("file_sync_outbox")
