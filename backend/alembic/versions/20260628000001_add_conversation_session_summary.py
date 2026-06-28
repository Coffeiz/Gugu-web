"""add summary to conversation_sessions（会话一句话总结，供跨 session 查找/续接）

Revision ID: 20260628000001
Revises: 20260627000002
Create Date: 2026-06-28

幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过，全新 DB / 从 base
重放都不会撞 DuplicateColumnError（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260628000001'
down_revision = '20260627000002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''")


def downgrade():
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS summary")
