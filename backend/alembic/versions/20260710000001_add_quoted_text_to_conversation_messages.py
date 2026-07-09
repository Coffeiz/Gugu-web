"""add quoted_text to conversation_messages（IM 引用/回复原文，单独存不拼进 content）

Revision ID: 20260710000001
Revises: 20260708000001
Create Date: 2026-07-10

幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260710000001'
down_revision = '20260708000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS quoted_text TEXT")


def downgrade():
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS quoted_text")
