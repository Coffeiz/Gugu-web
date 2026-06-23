"""add source column to conversation_sessions (会话来源 web/feishu/qqbot)

Revision ID: 20260623000002
Revises: 20260623000001
Create Date: 2026-06-23

幂等：用 ADD COLUMN IF NOT EXISTS——本地手动 ALTER 过的会跳过，服务器/全新 DB 会建。
"""
from alembic import op

revision = '20260623000002'
down_revision = '20260623000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "ALTER TABLE conversation_sessions "
        "ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'web'"
    )


def downgrade():
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS source")
