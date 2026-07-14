"""add ref_snapshot to mind_nodes

Revision ID: 20260714000002
Revises: 20260714000001
Create Date: 2026-07-14

项目引用（MindNode.ref_type='project'）被删后，ProjectRefCard 拿不到活的 Project 记录，
之前只缓存了 title（显示名）+ color（配色），客户/日期信息一律留白。加一列 ref_snapshot
（JSON，nullable）缓存创建引用那一刻的 {client, status, startDate, deadline, doneAt}，
让删除态快照能跟活着时的卡片同款字号/布局显示这些字段，跟 title/color 同一套「快照降级」
思路——只在创建时拍照，之后原对象改这些字段不会回填。nullable、无 server_default，
存量行读到 None，零迁移风险。
"""
import sqlalchemy as sa
from alembic import op

revision = "20260714000002"
down_revision = "20260714000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("mind_nodes", sa.Column("ref_snapshot", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("mind_nodes", "ref_snapshot")
