"""新增用户存储配额统一账本。"""
from alembic import op
import sqlalchemy as sa

revision = "20260826000001"
down_revision = "20260825000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "storage_quota_ledgers",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("root_path", sa.String(length=1000), nullable=True),
        sa.Column("limit_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("used_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("reserved_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column("initialized_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "category", name="uq_storage_quota_user_category"),
    )
    op.create_index("ix_storage_quota_ledgers_user_id", "storage_quota_ledgers", ["user_id"])
    op.create_index("ix_storage_quota_ledgers_category", "storage_quota_ledgers", ["category"])
    op.create_index("ix_storage_quota_user_status", "storage_quota_ledgers", ["user_id", "status"])
    op.create_table(
        "storage_quota_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("operation", sa.String(length=32), nullable=False),
        sa.Column("delta_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("resource_type", sa.String(length=32), nullable=True),
        sa.Column("resource_id", sa.String(length=255), nullable=True),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_storage_quota_event_idempotency"),
    )
    op.create_index("ix_storage_quota_events_user_id", "storage_quota_events", ["user_id"])
    op.create_index("ix_storage_quota_events_category", "storage_quota_events", ["category"])
    op.create_index("ix_storage_quota_events_operation", "storage_quota_events", ["operation"])
    op.create_index("ix_storage_quota_event_user_created", "storage_quota_events", ["user_id", "created_at"])
    op.create_index("ix_storage_quota_event_category_operation", "storage_quota_events", ["category", "operation"])


def downgrade() -> None:
    op.drop_index("ix_storage_quota_event_category_operation", table_name="storage_quota_events")
    op.drop_index("ix_storage_quota_event_user_created", table_name="storage_quota_events")
    op.drop_index("ix_storage_quota_events_operation", table_name="storage_quota_events")
    op.drop_index("ix_storage_quota_events_category", table_name="storage_quota_events")
    op.drop_index("ix_storage_quota_events_user_id", table_name="storage_quota_events")
    op.drop_table("storage_quota_events")
    op.drop_index("ix_storage_quota_user_status", table_name="storage_quota_ledgers")
    op.drop_index("ix_storage_quota_ledgers_category", table_name="storage_quota_ledgers")
    op.drop_index("ix_storage_quota_ledgers_user_id", table_name="storage_quota_ledgers")
    op.drop_table("storage_quota_ledgers")
