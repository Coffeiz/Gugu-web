"""add priority to projects

Revision ID: 20260622000001
Revises: 20260619000001
Create Date: 2026-06-22 00:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = '20260622000001'
down_revision = '20260619000001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('projects', sa.Column('priority', sa.String(20), nullable=True))


def downgrade():
    op.drop_column('projects', 'priority')
