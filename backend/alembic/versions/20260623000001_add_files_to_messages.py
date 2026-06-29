"""add files column to conversation_messages (咕咕发的文件卡片持久化)

Revision ID: 20260623000001
Revises: 20260622000007
Create Date: 2026-06-23
"""
from alembic import op
import sqlalchemy as sa

revision = '20260623000001'
down_revision = '20260622000007'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('conversation_messages', sa.Column('files', sa.JSON(), nullable=True))


def downgrade():
    op.drop_column('conversation_messages', 'files')
