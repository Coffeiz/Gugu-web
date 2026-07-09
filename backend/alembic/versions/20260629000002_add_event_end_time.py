"""add end_time to calendar_events（活动结束时间，支持开始-结束时间段）

Revision ID: 20260629000002
Revises: 20260629000001
Create Date: 2026-06-29

幂等：ADD COLUMN IF NOT EXISTS（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260629000002'
down_revision = '20260629000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS end_time VARCHAR(5)")


def downgrade():
    op.execute("ALTER TABLE calendar_events DROP COLUMN IF EXISTS end_time")
