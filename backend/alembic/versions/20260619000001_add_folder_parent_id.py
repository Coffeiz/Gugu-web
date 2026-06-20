"""add parent_id to folders

Revision ID: 20260619000001
Revises: 20260617000001
Create Date: 2026-06-19 00:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = '20260619000001'
down_revision = '20260617000001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('folders', sa.Column('parent_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_folders_parent_id', 'folders', 'folders',
        ['parent_id'], ['id'], ondelete='CASCADE'
    )
    op.create_index('ix_folders_parent_id', 'folders', ['parent_id'])


def downgrade():
    op.drop_index('ix_folders_parent_id', table_name='folders')
    op.drop_constraint('fk_folders_parent_id', 'folders', type_='foreignkey')
    op.drop_column('folders', 'parent_id')
