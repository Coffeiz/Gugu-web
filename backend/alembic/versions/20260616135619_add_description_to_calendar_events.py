"""add description to calendar_events

Revision ID: 20260616135619
Revises:
Create Date: 2026-06-16 13:56:19

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '20260616135619'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('calendar_events', sa.Column('description', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('calendar_events', 'description')
