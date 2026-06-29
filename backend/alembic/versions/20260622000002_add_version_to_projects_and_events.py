"""add version to projects and calendar_events

Revision ID: 20260622000002
Revises: 20260622000001
Create Date: 2026-06-22 00:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = '20260622000002'
down_revision = '20260622000001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('projects',        sa.Column('version', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('calendar_events', sa.Column('version', sa.Integer(), nullable=False, server_default='1'))


def downgrade():
    op.drop_column('projects',        'version')
    op.drop_column('calendar_events', 'version')
