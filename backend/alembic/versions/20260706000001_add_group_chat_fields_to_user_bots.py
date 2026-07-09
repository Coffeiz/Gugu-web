"""add group chat fields to user_bots（群聊开关 + 是否需要@）

Revision ID: 20260706000001
Revises: 20260702000002
Create Date: 2026-07-06

幂等：ADD COLUMN IF NOT EXISTS——已被 create_all 建过的跳过（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260706000001'
down_revision = '20260702000002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS group_chat_enabled BOOLEAN NOT NULL DEFAULT FALSE")
    op.execute("ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS group_requires_at BOOLEAN NOT NULL DEFAULT TRUE")


def downgrade():
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS group_chat_enabled")
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS group_requires_at")
