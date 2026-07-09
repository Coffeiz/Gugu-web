"""add is_developer to users（开发者标记：数据面板可一键排除开发者数据）

Revision ID: 20260702000001
Revises: 20260629000002
Create Date: 2026-07-02

幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260702000001'
down_revision = '20260629000002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_developer BOOLEAN NOT NULL DEFAULT FALSE")


def downgrade():
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS is_developer")
