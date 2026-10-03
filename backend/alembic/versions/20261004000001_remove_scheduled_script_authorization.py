"""移除定时任务脚本白名单字段。

Revision ID: 20261004000001
Revises: 20261003000002
Create Date: 2026-10-04
"""
from alembic import op
import sqlalchemy as sa


revision = "20261004000001"
down_revision = "20261003000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("scheduled_tasks", "script_authorization")


def downgrade() -> None:
    op.add_column(
        "scheduled_tasks",
        sa.Column("script_authorization", sa.JSON(), nullable=True),
    )
