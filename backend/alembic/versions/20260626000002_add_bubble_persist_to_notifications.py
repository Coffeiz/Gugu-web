"""给 site_notifications 加 bubble / persist / bubble_expire_at

Revision ID: 20260626000002
Revises: 20260626000001
Create Date: 2026-06-26

通知分渠道发布：bubble=是否弹气泡、persist=是否进通知中心；bubble_expire_at=气泡时限
（null=永久），过期后再登录的用户不再补弹。幂等 ADD COLUMN IF NOT EXISTS，老行默认值兼容。
"""
from alembic import op

revision = '20260626000002'
down_revision = '20260626000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE site_notifications ADD COLUMN IF NOT EXISTS bubble BOOLEAN NOT NULL DEFAULT true")
    op.execute("ALTER TABLE site_notifications ADD COLUMN IF NOT EXISTS persist BOOLEAN NOT NULL DEFAULT true")
    op.execute("ALTER TABLE site_notifications ADD COLUMN IF NOT EXISTS bubble_expire_at TIMESTAMP")


def downgrade():
    op.execute("ALTER TABLE site_notifications DROP COLUMN IF EXISTS bubble")
    op.execute("ALTER TABLE site_notifications DROP COLUMN IF EXISTS persist")
    op.execute("ALTER TABLE site_notifications DROP COLUMN IF EXISTS bubble_expire_at")
