"""add timezone to users（IANA 时区，日期归属/展示按它换算）

Revision ID: 20260711000001
Revises: 20260710000002
Create Date: 2026-07-11

见 docs/backend/时区与时钟迁移方案.md Phase 0：这是时区迁移的前置字段（可空，不阻塞老用户）。
幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过。
"""
from alembic import op

revision = '20260711000001'
down_revision = '20260710000002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64)")


def downgrade():
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS timezone")
