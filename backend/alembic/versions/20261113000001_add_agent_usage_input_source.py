"""为主对话用量保存实际输入入口。

Revision ID: 20261113000001
Revises: 20261112000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20261113000001"
down_revision = "20261112000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("agent_usage", sa.Column("input_source", sa.String(20), nullable=True))


def downgrade():
    op.drop_column("agent_usage", "input_source")
