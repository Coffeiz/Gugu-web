"""为用量记录保存逐轮缓存统计。

Revision ID: 20261112000001
Revises: 20261109000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20261112000001"
down_revision = "20261109000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("agent_usage", sa.Column("cache_round_stats", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("agent_usage", "cache_round_stats")
