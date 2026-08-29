"""新增脱敏安全事件事实表。"""

from alembic import op
import sqlalchemy as sa


revision = "20260829000002"
down_revision = "20260829000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("security_events"):
        op.create_table(
            "security_events",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False),
            sa.Column("event_type", sa.String(length=80), nullable=False),
            sa.Column("resource_type", sa.String(length=120), nullable=False),
            sa.Column("resource_fingerprint", sa.String(length=64), nullable=False),
            sa.Column("owner_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("client_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("ip_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("user_agent_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("action", sa.String(length=32), nullable=False, server_default="logged"),
            sa.Column("reason_code", sa.String(length=80), nullable=False),
            sa.Column("metadata_json", sa.JSON(), nullable=False),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
    inspector = sa.inspect(bind)
    existing = {item["name"] for item in inspector.get_indexes("security_events")}
    for name, columns in {
        "ix_security_events_user_id": ["user_id"],
        "ix_security_events_event_type": ["event_type"],
        "ix_security_events_resource_fingerprint": ["resource_fingerprint"],
        "ix_security_events_action": ["action"],
        "ix_security_events_reason_code": ["reason_code"],
        "ix_security_events_occurred_at": ["occurred_at"],
        "ix_security_events_expires_at": ["expires_at"],
        "ix_security_events_user_occurred": ["user_id", "occurred_at"],
        "ix_security_events_type_occurred": ["event_type", "occurred_at"],
    }.items():
        if name not in existing:
            op.create_index(name, "security_events", columns)


def downgrade() -> None:
    op.drop_table("security_events")
