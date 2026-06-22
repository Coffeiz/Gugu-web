"""add avatar to users

Revision ID: 20260622000003
Revises: 20260622000002
Create Date: 2026-06-22 00:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = '20260622000003'
down_revision = '20260622000002'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('avatar', sa.String(500), nullable=True))


def downgrade():
    op.drop_column('users', 'avatar')
