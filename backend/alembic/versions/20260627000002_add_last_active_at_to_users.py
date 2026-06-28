"""add last_active_at to users（DAU 活跃判定字段）

Revision ID: 20260627000002
Revises: 20260627000001
Create Date: 2026-06-27

幂等：ADD COLUMN / CREATE INDEX IF NOT EXISTS——已被 create_all 建过的跳过，
全新 DB / 从 base 重放都不会撞 DuplicateColumnError（见 deploy.md §10.2）。
"""
from alembic import op

revision = '20260627000002'
down_revision = '20260627000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP WITHOUT TIME ZONE")
    op.execute("CREATE INDEX IF NOT EXISTS ix_users_last_active_at ON users (last_active_at)")


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_users_last_active_at")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS last_active_at")
