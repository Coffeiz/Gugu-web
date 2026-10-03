"""Add per-user notification dismissal state.

Revision ID: 20261002000002
Revises: 20261001000002
"""
from alembic import op
import sqlalchemy as sa


revision = "20261002000002"
down_revision = "20261001000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notification_dismissals",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("notification_id", sa.Integer(), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["notification_id"], ["site_notifications.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "notification_id", name="uq_notif_dismissal"),
    )
    op.create_index("ix_notification_dismissals_user_id", "notification_dismissals", ["user_id"])
    op.create_index("ix_notification_dismissals_notification_id", "notification_dismissals", ["notification_id"])


def downgrade() -> None:
    op.drop_index("ix_notification_dismissals_notification_id", table_name="notification_dismissals")
    op.drop_index("ix_notification_dismissals_user_id", table_name="notification_dismissals")
    op.drop_table("notification_dismissals")
