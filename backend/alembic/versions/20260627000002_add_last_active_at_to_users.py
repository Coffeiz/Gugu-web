"""add last_active_at to users

Revision ID: 20260627000002
Revises: 20260627000001
Create Date: 2026-06-27
"""
from alembic import op
import sqlalchemy as sa

revision = '20260627000002'
down_revision = '20260627000001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('last_active_at', sa.DateTime(), nullable=True))
    op.create_index('ix_users_last_active_at', 'users', ['last_active_at'])


def downgrade():
    op.drop_index('ix_users_last_active_at', table_name='users')
    op.drop_column('users', 'last_active_at')
