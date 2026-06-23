"""add tools_used column to agent_usage (每次生成用到的工具名列表)

Revision ID: 20260623000003
Revises: 20260623000002
Create Date: 2026-06-23

幂等：用 ADD COLUMN IF NOT EXISTS——本地手动 ALTER 过的会跳过，服务器/全新 DB 会建。
（这列原来只手动 ALTER 过没建迁移，导致生产缺列时整条生成链路存用量 UndefinedColumnError 崩，故补上。）
"""
from alembic import op

revision = '20260623000003'
down_revision = '20260623000002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE agent_usage ADD COLUMN IF NOT EXISTS tools_used JSON")


def downgrade():
    op.execute("ALTER TABLE agent_usage DROP COLUMN IF EXISTS tools_used")
