"""add 6h and weekly token rate limits

Revision ID: 20260622000007
Revises: 20260622000006
Create Date: 2026-06-22
"""
from alembic import op
import sqlalchemy as sa

revision = '20260622000007'
down_revision = '20260622000006'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('token_limit_6h',     sa.Integer(), nullable=True))
    op.add_column('users', sa.Column('token_limit_weekly', sa.Integer(), nullable=True))


def downgrade():
    op.drop_column('users', 'token_limit_weekly')
    op.drop_column('users', 'token_limit_6h')
