"""为项目和日历创建请求增加幂等键。

Revision ID: 20261020000001
Revises: 20261018000001
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa


revision = "20261020000001"
down_revision = "20261018000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("projects", "calendar_events"):
        op.add_column(table, sa.Column("idempotency_key", sa.String(length=64), nullable=True))
        op.add_column(table, sa.Column("idempotency_fingerprint", sa.String(length=64), nullable=True))
        op.create_unique_constraint(
            f"uq_{table}_user_idempotency_key", table, ["user_id", "idempotency_key"]
        )


def downgrade() -> None:
    for table in ("calendar_events", "projects"):
        op.drop_constraint(f"uq_{table}_user_idempotency_key", table, type_="unique")
        op.drop_column(table, "idempotency_fingerprint")
        op.drop_column(table, "idempotency_key")
