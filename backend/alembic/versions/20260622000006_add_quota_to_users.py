"""add quota fields to users

Revision ID: 20260622000006
Revises: 20260622000005
Create Date: 2026-06-22
"""
from alembic import op
import sqlalchemy as sa

revision = '20260622000006'
down_revision = '20260622000005'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('token_limit_monthly', sa.Integer(), nullable=True))
    op.add_column('users', sa.Column('storage_limit_bytes', sa.BigInteger(), nullable=True))


def downgrade():
    op.drop_column('users', 'storage_limit_bytes')
    op.drop_column('users', 'token_limit_monthly')
