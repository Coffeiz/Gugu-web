"""add context_config to scheduled_tasks（按需精简注入用的工具组/上下文开关）

Revision ID: 20260708000001
Revises: 20260706000001
Create Date: 2026-07-08

幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260708000001'
down_revision = '20260706000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS context_config JSON")


def downgrade():
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS context_config")
