"""persist web chat @ references for history rendering

Revision ID: 20260831000001
Revises: 20260830000003
Create Date: 2026-08-31

幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过（见 deploy.md §10.2）。
"""
from alembic import op


revision = '20260831000001'
down_revision = '20260830000003'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS references_json JSONB NULL")


def downgrade():
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS references_json")
