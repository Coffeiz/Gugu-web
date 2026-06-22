"""add display_name to users

Revision ID: 20260622000005
Revises: 20260622000004
Create Date: 2026-06-22 00:00:00
"""
import sqlalchemy as sa
from alembic import op

revision = '20260622000005'
down_revision = '20260622000004'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('display_name', sa.String(100), nullable=True))
    # 默认用登录名填充
    op.execute("UPDATE users SET display_name = username WHERE display_name IS NULL")


def downgrade():
    op.drop_column('users', 'display_name')
